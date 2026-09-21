/**
 * Hedera SDK adapter of the HTS operations: the only module that talks to consensus nodes about tokens.
 *
 * Every transaction carries a settlement memo (`hvs:1:<eventKey>:<step>`), is sent ONCE, never regenerates its transaction
 * id (so an SDK-internal node retry re-sends the SAME transaction, which the network deduplicates), and reports its
 * transaction id before sending so a timeout can still be correlated and reconciled.
 *
 * Trust model: minting and moving the settlement token off-chain is only possible when the operator holds the treasury and
 * supply keys ("operator custody", dev/test). In production (router custody) only the SettlementRouter holds them.
 */
import { HtsError } from "./errors";

export interface StepRequest {
  memo: string;
  timeoutMs: number;
  /** Called as soon as the transaction id exists, before sending. */
  onTransactionId(transactionId: string): void;
}

export interface StepReceipt {
  transactionId: string;
  /** `seconds.nanoseconds`, from the transaction record. Empty only for an `alreadyAssociated` association. */
  consensusTimestamp: string;
}

/** Sends one HTS operation exactly once and reports the consensus result. It must not retry. */
export interface HtsExecutor {
  associate(
    request: StepRequest & { accountId: string; tokenId: string },
  ): Promise<StepReceipt & { alreadyAssociated: boolean }>;
  mint(request: StepRequest & { tokenId: string; amount: bigint }): Promise<StepReceipt>;
  transfer(request: StepRequest & { tokenId: string; from: string; to: string; amount: bigint }): Promise<StepReceipt>;
}

// Minimal structural view of the parts of @hiero-ledger/sdk used here, so the adapter is testable with fakes.
interface LongLike {
  toString(): string;
}
interface RecordLike {
  transactionId?: { toString(): string } | null;
  consensusTimestamp: { seconds: LongLike; nanos: LongLike };
}
interface ResponseLike {
  transactionId: { toString(): string };
  getRecord(client: unknown): Promise<RecordLike>;
}
export interface HtsTransactionLike {
  setTransactionMemo(memo: string): this;
  setRegenerateTransactionId(regenerate: boolean): this;
  setMaxAttempts(attempts: number): this;
  setGrpcDeadline(milliseconds: number): this;
  freezeWith(client: unknown): this;
  sign(key: unknown): Promise<this>;
  readonly transactionId: { toString(): string } | null;
  execute(client: unknown): Promise<ResponseLike>;
}
export interface TokenAssociateTransactionLike extends HtsTransactionLike {
  setAccountId(accountId: string): this;
  setTokenIds(tokenIds: string[]): this;
}
export interface TokenMintTransactionLike extends HtsTransactionLike {
  setTokenId(tokenId: string): this;
  setAmount(amount: bigint): this;
}
export interface TransferTransactionLike extends HtsTransactionLike {
  addTokenTransfer(tokenId: string, accountId: string, amount: bigint): this;
}
export interface HieroHtsSdkLike {
  TokenAssociateTransaction: new () => TokenAssociateTransactionLike;
  TokenMintTransaction: new () => TokenMintTransactionLike;
  TransferTransaction: new () => TransferTransactionLike;
}

export interface HieroExecutorOptions {
  /** A configured client with the operator set. */
  client: unknown;
  /** The operator account id: the payer, and the only account it can associate without another key. */
  operatorId: string;
  /** Private keys of OTHER accounts this process may sign for (an association needs the account's own key). */
  accountKeys?: Record<string, unknown>;
  /** The Hedera SDK module. Defaults to a lazy `import("@hiero-ledger/sdk")`. */
  sdk?: HieroHtsSdkLike;
  /** Node-level attempts of the SAME transaction. Default 3. */
  maxAttempts?: number;
}

const timestamp = (record: RecordLike) =>
  `${record.consensusTimestamp.seconds}.${record.consensusTimestamp.nanos.toString().padStart(9, "0")}`;

async function send(
  tx: HtsTransactionLike,
  options: HieroExecutorOptions,
  request: StepRequest,
  signWith?: unknown,
): Promise<StepReceipt> {
  tx.setTransactionMemo(request.memo)
    .setRegenerateTransactionId(false)
    .setMaxAttempts(options.maxAttempts ?? 3)
    .setGrpcDeadline(Math.max(1_000, Math.floor(request.timeoutMs / 2)))
    .freezeWith(options.client);
  if (signWith !== undefined) await tx.sign(signWith);
  if (tx.transactionId) request.onTransactionId(tx.transactionId.toString());

  const response = await tx.execute(options.client);
  request.onTransactionId(response.transactionId.toString());
  // getRecord waits for the receipt and throws `ReceiptStatusError` when consensus ended with a failure status.
  const record = await response.getRecord(options.client);
  return {
    transactionId: (record.transactionId ?? response.transactionId).toString(),
    consensusTimestamp: timestamp(record),
  };
}

async function sdkOf(options: HieroExecutorOptions): Promise<HieroHtsSdkLike> {
  return options.sdk ?? ((await import("@hiero-ledger/sdk")) as unknown as HieroHtsSdkLike);
}

export function createHieroHtsExecutor(options: HieroExecutorOptions): HtsExecutor {
  return {
    async associate(request) {
      const key = request.accountId === options.operatorId ? undefined : options.accountKeys?.[request.accountId];
      if (request.accountId !== options.operatorId && key === undefined) {
        throw new HtsError({
          code: "ASSOCIATION_NOT_AUTHORIZED",
          outcome: "not_sent",
          operation: "associate",
          message: `Account ${request.accountId} must sign its own association, and this process does not hold its key.`,
          remediation:
            "Ask the account owner to associate the token (from its wallet, or a TokenAssociateTransaction signed by that account), or supply that account's key to the executor.",
          retryable: false,
          accountId: request.accountId,
          tokenId: request.tokenId,
        });
      }
      const sdk = await sdkOf(options);
      const tx = new sdk.TokenAssociateTransaction().setAccountId(request.accountId).setTokenIds([request.tokenId]);
      try {
        return { ...(await send(tx, options, request, key)), alreadyAssociated: false };
      } catch (error) {
        // Associating twice is not a failure: the account can already receive the token. Idempotent by design.
        if (String((error as { status?: unknown } | null)?.status) === "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT") {
          const id = (error as { transactionId?: { toString(): string } }).transactionId?.toString() ?? "";
          return { transactionId: id, consensusTimestamp: "", alreadyAssociated: true };
        }
        throw error;
      }
    },

    async mint(request) {
      const sdk = await sdkOf(options);
      return send(
        new sdk.TokenMintTransaction().setTokenId(request.tokenId).setAmount(request.amount),
        options,
        request,
      );
    },

    async transfer(request) {
      const sdk = await sdkOf(options);
      const tx = new sdk.TransferTransaction()
        .addTokenTransfer(request.tokenId, request.from, -request.amount)
        .addTokenTransfer(request.tokenId, request.to, request.amount);
      return send(tx, options, request);
    },
  };
}

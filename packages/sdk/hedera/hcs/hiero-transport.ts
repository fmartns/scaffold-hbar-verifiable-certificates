/**
 * Hedera SDK adapter of the HCS publisher: the only module that talks to consensus nodes.
 *
 * It sends ONE `TopicMessageSubmitTransaction`, then waits for the record. Its guarantees:
 *  - it never regenerates the transaction ID, so a node-level retry inside the SDK re-sends the SAME transaction, which the
 *    network deduplicates (`DUPLICATE_TRANSACTION`); no second message can come from SDK-internal retries;
 *  - it reports the transaction ID before sending, so a timeout can still be correlated;
 *  - the sequence number and running hash come from the receipt and the consensus timestamp from the record (NV-6).
 */
import { ENV as HEDERA_ENV, inspectPrivateKey } from "../environment";
import type { EnvironmentVariables, PublicKeyCandidate } from "../environment";
import type { HederaNetwork } from "../networks";
import { loadHcsPublisherConfig } from "./config";
import { HcsPublishError } from "./errors";
import { createHcsPublisher } from "./publisher";
import type {
  CreatePublisherOptions,
  HcsPublisher,
  HcsTransport,
  TransportReceipt,
  TransportRequest,
} from "./publisher";

// Minimal structural view of the parts of @hiero-ledger/sdk used here, so the adapter can be tested with fakes.
interface LongLike {
  toString(): string;
}
interface TransactionRecordLike {
  transactionId?: { toString(): string } | null;
  consensusTimestamp: { seconds: LongLike; nanos: LongLike };
  receipt: { topicSequenceNumber: LongLike | null; topicRunningHash: Uint8Array | null };
}
interface TransactionResponseLike {
  transactionId: { toString(): string };
  getRecord(client: unknown): Promise<TransactionRecordLike>;
}
export interface TopicMessageSubmitTransactionLike {
  setTopicId(topicId: string): this;
  setMessage(message: Uint8Array): this;
  setRegenerateTransactionId(regenerate: boolean): this;
  setMaxAttempts(attempts: number): this;
  setGrpcDeadline(milliseconds: number): this;
  freezeWith(client: unknown): this;
  readonly transactionId: { toString(): string } | null;
  execute(client: unknown): Promise<TransactionResponseLike>;
}
export interface HieroSdkLike {
  TopicMessageSubmitTransaction: new () => TopicMessageSubmitTransactionLike;
}

export interface HieroTransportOptions {
  /** A configured client with the operator set. */
  client: unknown;
  /** The Hedera SDK module. Defaults to a lazy `import("@hiero-ledger/sdk")`. */
  sdk?: HieroSdkLike;
  /** Node-level attempts of the SAME transaction. Default 3. */
  maxAttempts?: number;
}

function formatTimestamp(seconds: LongLike, nanos: LongLike): string {
  return `${seconds.toString()}.${nanos.toString().padStart(9, "0")}`;
}

function toHex(bytes: Uint8Array | null): string {
  return bytes ? Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("") : "";
}

export function createHieroTransport(options: HieroTransportOptions): HcsTransport {
  return {
    async submit(request: TransportRequest): Promise<TransportReceipt> {
      const sdk = options.sdk ?? ((await import("@hiero-ledger/sdk")) as unknown as HieroSdkLike);
      const transaction = new sdk.TopicMessageSubmitTransaction()
        .setTopicId(request.topicId)
        .setMessage(request.message)
        .setRegenerateTransactionId(false)
        .setMaxAttempts(options.maxAttempts ?? 3)
        .setGrpcDeadline(Math.max(1_000, Math.floor(request.timeoutMs / 2)))
        .freezeWith(options.client);
      if (transaction.transactionId) request.onTransactionId(transaction.transactionId.toString());

      const response = await transaction.execute(options.client);
      request.onTransactionId(response.transactionId.toString());
      // getRecord waits for the receipt and throws `ReceiptStatusError` when consensus ended with a failure status.
      const record = await response.getRecord(options.client);
      return {
        transactionId: (record.transactionId ?? response.transactionId).toString(),
        sequenceNumber: record.receipt.topicSequenceNumber?.toString() ?? "",
        runningHash: toHex(record.receipt.topicRunningHash),
        consensusTimestamp: formatTimestamp(record.consensusTimestamp.seconds, record.consensusTimestamp.nanos),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Factory from the environment
// ---------------------------------------------------------------------------------------------------------------------

export interface FromEnvOptions extends CreatePublisherOptions {
  fetch?: typeof fetch;
  /** Overrides the transport (tests, alternative clients). When set, no Hedera client is created. */
  transport?: HcsTransport;
}

export interface HcsPublisherHandle {
  publisher: HcsPublisher;
  /** Releases the network client. Safe to call more than once. */
  close(): void;
}

const configError = (variable: string, message: string, remediation: string) =>
  new HcsPublishError({
    code: "CONFIG_INVALID",
    outcome: "not_sent",
    message,
    remediation,
    retryable: false,
    configIssues: [{ variable, message, remediation }],
  });

export interface HieroPrivateKeySdk {
  PrivateKey: {
    fromStringDer(k: string): unknown;
    fromStringED25519(k: string): unknown;
    fromStringECDSA(k: string): unknown;
  };
}

/**
 * Resolves a raw hex private key against the account it must belong to. A DER-encoded key carries its own curve; a raw
 * 32-byte key does not, so the account's actual key on the network decides between ED25519 and ECDSA. Never echoes the
 * key: on any failure it throws with only the variable name and a generic reason.
 */
export async function resolveKeyForAccount(
  rawKey: string,
  accountId: string,
  network: HederaNetwork,
  sdk: HieroPrivateKeySdk,
  fetchImpl: typeof fetch,
  variable: string,
): Promise<unknown> {
  const raw = rawKey.trim().replace(/^0x/i, "");
  const fix = `Set ${variable} to the private key of ${accountId} (a DER-encoded key is unambiguous).`;
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw configError(variable, `${variable} is not a hex-encoded private key.`, fix);
  }
  try {
    if (raw.startsWith("30")) return sdk.PrivateKey.fromStringDer(raw);
    const candidates: PublicKeyCandidate[] | null = await inspectPrivateKey(raw);
    if (!candidates) throw new Error("no candidates");
    const response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1/accounts/${accountId}?transactions=false`);
    const account = (await response.json()) as { key?: { _type?: string; key?: string } | null };
    const match = candidates.find(c => c.publicKey === account.key?.key?.toLowerCase());
    if (!match) throw new Error("no match");
    return match.type === "ED25519" ? sdk.PrivateKey.fromStringED25519(raw) : sdk.PrivateKey.fromStringECDSA(raw);
  } catch {
    throw configError(
      variable,
      `Could not determine the type of ${variable} (ED25519 or ECDSA) or it does not match account ${accountId}.`,
      `${fix} Run \`yarn setup\` to diagnose.`,
    );
  }
}

async function resolveOperatorKey(
  env: EnvironmentVariables,
  network: HederaNetwork,
  accountId: string,
  sdk: HieroPrivateKeySdk,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  return resolveKeyForAccount(
    env[HEDERA_ENV.OPERATOR_KEY] ?? "",
    accountId,
    network,
    sdk,
    fetchImpl,
    HEDERA_ENV.OPERATOR_KEY,
  );
}

export interface OperatorClient {
  /** A Hedera client with the operator set. */
  client: { close(): void };
  /** The operator private key object (never serialize it). */
  key: { publicKey: unknown };
  sdk: HieroSdkLike;
  /** Releases the network client. Safe to call more than once. */
  close(): void;
}

/**
 * Creates the Hedera client for the selected network with the operator from the environment. Throws `HcsPublishError`
 * with `CONFIG_INVALID` when the operator is missing or its key cannot be resolved. Never echoes the key.
 */
export async function createOperatorClient(
  env: EnvironmentVariables,
  network: HederaNetwork,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OperatorClient> {
  const operatorId = env[HEDERA_ENV.OPERATOR_ID]?.trim();
  if (!operatorId || !/^\d+\.\d+\.\d+$/.test(operatorId)) {
    throw configError(
      HEDERA_ENV.OPERATOR_ID,
      "HEDERA_OPERATOR_ID is missing or not a valid account id.",
      "Set HEDERA_OPERATOR_ID=0.0.<your account>. Run `yarn setup` to diagnose.",
    );
  }
  const sdk = await import("@hiero-ledger/sdk");
  const key = await resolveOperatorKey(env, network, operatorId, sdk as never, fetchImpl);
  const { Client } = sdk;
  const client =
    network.name === "mainnet"
      ? Client.forMainnet()
      : network.name === "testnet"
        ? Client.forTestnet()
        : Client.forNetwork({ "127.0.0.1:50211": "0.0.3" }).setMirrorNetwork("127.0.0.1:5600");
  client.setOperator(operatorId, key as never);
  let closed = false;
  return {
    client,
    key: key as { publicKey: unknown },
    sdk: sdk as unknown as HieroSdkLike,
    close: () => {
      if (!closed) {
        closed = true;
        client.close();
      }
    },
  };
}

/**
 * Builds a publisher from the environment: loads the configuration, creates the Hedera client with the operator key and
 * wires the SDK transport. Throws `HcsPublishError` with `CONFIG_INVALID` when the environment is not usable. The
 * operator key is read here only to create the client; it is never stored in the result.
 */
export async function createHcsPublisherFromEnv(
  env: EnvironmentVariables,
  options: FromEnvOptions = {},
): Promise<HcsPublisherHandle> {
  const config = loadHcsPublisherConfig(env);
  if (options.transport) {
    return { publisher: createHcsPublisher(config, options.transport, options), close: () => undefined };
  }
  const operator = await createOperatorClient(env, config.network, options.fetch);
  return {
    publisher: createHcsPublisher(
      config,
      createHieroTransport({ client: operator.client, sdk: operator.sdk }),
      options,
    ),
    close: operator.close,
  };
}

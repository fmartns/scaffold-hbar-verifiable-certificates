/**
 * OPTIONAL integration test against the real Hedera Testnet. Skipped unless explicitly enabled:
 *
 *     HTS_INTEGRATION=1 yarn workspace @sh/sdk test:integration
 *
 * It exercises the real HTS operations of the flow: association, mint, transfer, the memo-based reconciliation on the real
 * Mirror Node and the real HTS error statuses. Credentials come from the environment or the repository's root `.env`:
 *
 *     HEDERA_NETWORK=testnet   HEDERA_OPERATOR_ID=0.0.x   HEDERA_OPERATOR_KEY=...
 *     HEDERA_HTS_TOKEN_ID=0.0.y   (optional)
 *
 * Without HEDERA_HTS_TOKEN_ID it creates a throwaway token whose treasury and supply key are the operator (operator custody,
 * dev only), plus a fresh beneficiary account with NO automatic association, and deletes both at the end. A token that you
 * provide must have the operator as treasury and supply key; it is not deleted. Testnet HBAR only; nothing secret is printed.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectPrivateKey } from "../environment";
import { createOperatorClient } from "../hcs/hiero-transport";
import { getSelectedNetwork } from "../networks";
import { createHtsSettlementAdapter } from "./adapter";
import { loadHtsAdapterConfig } from "./config";
import { classifyHtsError } from "./errors";
import { createHieroHtsExecutor } from "./executor";
import type { HieroHtsSdkLike } from "./executor";
import { preflightHtsAdapter } from "./factory";
import { createInMemoryLedger } from "./ledger";
import { createHtsMirror } from "./mirror";

const enabled = process.env.HTS_INTEGRATION === "1";

function integrationEnv(): Record<string, string | undefined> {
  const rootEnv = resolve(__dirname, "../../../../.env");
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv); // never overrides variables that are already set
  return {
    ...process.env,
    HEDERA_NETWORK: "testnet",
    HEDERA_HTS_CUSTODY: "operator",
    HEDERA_SETTLEMENT_ROUTER_ADDRESS: "",
  };
}

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, attempts = 25): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 1_500)); // Mirror Node is eventually consistent (ADR §3.8)
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const AMOUNT = 250n;
const eventKey = keccak256(toUtf8Bytes(`hts-integration:${Date.now()}`));
const settlementId = keccak256(toUtf8Bytes(`hts-integration-settlement:${Date.now()}`));
const contentHash = keccak256(toUtf8Bytes("hts-integration-content"));

describe.skipIf(!enabled)("HTS adapter on Hedera Testnet (real network)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;
  const s: {
    env: Record<string, string | undefined>;
    sdk: Any;
    operator: Any;
    operatorId: string;
    tokenId: string;
    createdToken: boolean;
    beneficiaryId: string;
    beneficiaryKey: Any;
    adapter: ReturnType<typeof createHtsSettlementAdapter>;
    executor: ReturnType<typeof createHieroHtsExecutor>;
    mirror: ReturnType<typeof createHtsMirror>;
    ledger: ReturnType<typeof createInMemoryLedger>;
    config: ReturnType<typeof loadHtsAdapterConfig>;
    input: {
      eventKey: string;
      settlementId: string;
      contentHash: string;
      tokenId: string;
      beneficiary: string;
      amount: bigint;
    };
  } = {} as Any;

  beforeAll(async () => {
    s.env = integrationEnv();
    const network = getSelectedNetwork(s.env);
    s.mirror = createHtsMirror(network);
    s.operator = await createOperatorClient(s.env, network);
    s.sdk = s.operator.sdk;
    s.operatorId = s.env.HEDERA_OPERATOR_ID as string;
    const { TokenCreateTransaction, TokenType, TokenSupplyType, AccountCreateTransaction, Hbar, PrivateKey } =
      s.sdk as Any;

    if (s.env.HEDERA_HTS_TOKEN_ID) {
      s.tokenId = s.env.HEDERA_HTS_TOKEN_ID;
    } else {
      const created = await new TokenCreateTransaction()
        .setTokenName("Settlement Integration Test")
        .setTokenSymbol("HVSIT")
        .setTokenType(TokenType.FungibleCommon)
        .setSupplyType(TokenSupplyType.Infinite)
        .setDecimals(2)
        .setInitialSupply(1000)
        .setTreasuryAccountId(s.operatorId)
        .setAdminKey(s.operator.key.publicKey)
        .setSupplyKey(s.operator.key.publicKey)
        .setTokenMemo("hvs integration test (throwaway)")
        .execute(s.operator.client);
      s.tokenId = String((await created.getReceipt(s.operator.client)).tokenId);
      s.createdToken = true;
    }
    s.env.HEDERA_HTS_TOKEN_ID = s.tokenId;

    // A fresh beneficiary that does NOT auto-associate, so association is a real step.
    s.beneficiaryKey = PrivateKey.generateED25519();
    const account = await new AccountCreateTransaction()
      .setKey(s.beneficiaryKey.publicKey)
      .setInitialBalance(Hbar.fromTinybars(0))
      .setMaxAutomaticTokenAssociations(0)
      .execute(s.operator.client);
    s.beneficiaryId = String((await account.getReceipt(s.operator.client)).accountId);

    s.config = loadHtsAdapterConfig(s.env);
    s.executor = createHieroHtsExecutor({
      client: s.operator.client,
      operatorId: s.operatorId,
      accountKeys: { [s.beneficiaryId]: s.beneficiaryKey },
      sdk: s.sdk as HieroHtsSdkLike,
    });
    s.ledger = createInMemoryLedger();
    const operatorKeys = (await inspectPrivateKey(s.env.HEDERA_OPERATOR_KEY ?? "")) ?? [];
    s.adapter = createHtsSettlementAdapter({
      config: s.config,
      executor: s.executor,
      ledger: s.ledger,
      operatorKeys,
      timeoutMs: 60_000,
    });
    s.input = { eventKey, settlementId, contentHash, tokenId: s.tokenId, beneficiary: s.beneficiaryId, amount: AMOUNT };

    await until("the beneficiary account on Mirror Node", () => s.mirror.getAccount(s.beneficiaryId));
    await until("the token on Mirror Node", () => s.mirror.getToken(s.tokenId));
    console.info(`HTS integration: token ${s.tokenId}, beneficiary ${s.beneficiaryId}`);
  }, 180_000);

  afterAll(async () => {
    if (!s.operator) return;
    const { TokenDeleteTransaction, TokenDissociateTransaction, AccountDeleteTransaction } = s.sdk as Any;
    // Best-effort cleanup of what this run created. A token you provided is never touched.
    try {
      if (s.createdToken) {
        await (
          await new TokenDeleteTransaction().setTokenId(s.tokenId).execute(s.operator.client)
        ).getReceipt(s.operator.client);
        const dissociate = await new TokenDissociateTransaction()
          .setAccountId(s.beneficiaryId)
          .setTokenIds([s.tokenId])
          .freezeWith(s.operator.client)
          .sign(s.beneficiaryKey);
        await (await dissociate.execute(s.operator.client)).getReceipt(s.operator.client);
      }
      const remove = await new AccountDeleteTransaction()
        .setAccountId(s.beneficiaryId)
        .setTransferAccountId(s.operatorId)
        .freezeWith(s.operator.client)
        .sign(s.beneficiaryKey);
      await (await remove.execute(s.operator.client)).getReceipt(s.operator.client);
    } catch {
      // Leftovers on Testnet are harmless.
    } finally {
      s.operator.close();
    }
  }, 120_000);

  it("the setup is valid: the environment (#5), the token and the operator custody", async () => {
    const result = await preflightHtsAdapter(s.env);
    if (!result.ok) throw new Error(`Setup invalid: ${result.error.message} ${result.error.remediation}`);
    expect(result.setup.checks.map(c => c.id)).toEqual(
      expect.arrayContaining(["token-exists", "token-usable", "custody-treasury", "mint-permission"]),
    );
  }, 60_000);

  it("REAL errors are classified specifically: not associated and token not found", async () => {
    // Ensure the treasury holds something, so the failures below are the ones being asserted.
    const treasury = await s.mirror.getRelationship(s.operatorId, s.tokenId);
    if (!treasury || treasury.balance < 1n)
      await s.executor.mint({
        tokenId: s.tokenId,
        amount: 1n,
        memo: "hvs:1:integration-seed",
        timeoutMs: 60_000,
        onTransactionId: () => undefined,
      });

    const failing = async (run: () => Promise<unknown>, ctx: Parameters<typeof classifyHtsError>[1]) =>
      classifyHtsError(
        await run().then(
          () => null,
          e => e,
        ),
        ctx,
      );

    // The account exists but is not associated, and has no automatic associations.
    const notAssociated = await failing(
      () =>
        s.executor.transfer({
          tokenId: s.tokenId,
          from: s.operatorId,
          to: s.beneficiaryId,
          amount: 1n,
          memo: "hvs:1:integration-probe",
          timeoutMs: 60_000,
          onTransactionId: () => undefined,
        }),
      { operation: "transfer", tokenId: s.tokenId, accountId: s.beneficiaryId },
    );
    expect(notAssociated).toMatchObject({
      code: "NOT_ASSOCIATED",
      hederaStatus: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
      outcome: "rejected",
    });

    const noToken = await failing(
      () =>
        s.executor.mint({
          tokenId: "0.0.999999999",
          amount: 1n,
          memo: "hvs:1:integration-probe",
          timeoutMs: 60_000,
          onTransactionId: () => undefined,
        }),
      { operation: "mint", tokenId: "0.0.999999999" },
    );
    expect(noToken).toMatchObject({ code: "TOKEN_NOT_FOUND", hederaStatus: "INVALID_TOKEN_ID" });
  }, 180_000);

  it("the settlement preflight reports NOT_ASSOCIATED for the fresh beneficiary, without sending anything", async () => {
    const outcome = await s.adapter.preflight(s.input);
    expect(outcome).toMatchObject({
      valid: true,
      ok: false,
      association: "not_associated",
      failure: { code: "NOT_ASSOCIATED", outcome: "not_sent" },
    });
    const refused = await s.adapter.settle(s.input);
    expect(refused).toMatchObject({ ok: false, failure: { code: "NOT_ASSOCIATED", outcome: "not_sent" } });
  }, 60_000);

  it("associates the beneficiary (signed by its own key), and a second association is a no-op", async () => {
    const first = await s.adapter.associate({ accountId: s.beneficiaryId });
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, status: "associated" });
    if (first.ok && first.operation)
      expect(first.operation.hashscanUrl).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\/\d+\.\d{9}$/);
    await until("the association on Mirror Node", () => s.mirror.getRelationship(s.beneficiaryId, s.tokenId));
    expect(await s.adapter.associate({ accountId: s.beneficiaryId })).toMatchObject({
      ok: true,
      status: "already_associated",
      operation: null,
    });
  }, 120_000);

  it("REAL insufficient balance is classified specifically (the associated beneficiary asks for more than the treasury holds)", async () => {
    const error = await s.executor
      .transfer({
        tokenId: s.tokenId,
        from: s.operatorId,
        to: s.beneficiaryId,
        amount: 1_000_000_000_000_000n,
        memo: "hvs:1:integration-probe",
        timeoutMs: 60_000,
        onTransactionId: () => undefined,
      })
      .then(
        () => null,
        e => e,
      );
    expect(
      classifyHtsError(error, { operation: "transfer", tokenId: s.tokenId, accountId: s.beneficiaryId }),
    ).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      hederaStatus: "INSUFFICIENT_TOKEN_BALANCE",
      outcome: "rejected",
    });
  }, 120_000);

  let supplyBefore = 0n;
  it("settles: mints and transfers to the beneficiary, with valid transaction ids and HashScan links", async () => {
    supplyBefore = (await s.mirror.getToken(s.tokenId))?.totalSupply ?? 0n;
    const result = await s.adapter.settle(s.input);
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      status: "settled",
      replay: false,
      source: "executed",
      idempotencyKey: eventKey,
      settlementId,
      tokenId: s.tokenId,
      to: s.beneficiaryId,
      amount: AMOUNT.toString(),
    });
    if (!result.ok) return;
    expect(result.operations.map(o => o.operation)).toEqual(["mint", "transfer"]);
    for (const op of result.operations) {
      expect(op.transactionId).toMatch(/^0\.0\.\d+@\d+\.\d+$/);
      expect(op.mirrorTransactionId).toMatch(/^0\.0\.\d+-\d+-\d+$/);
      expect(op.hashscanUrl).toMatch(/^https:\/\/hashscan\.io\/testnet\/transaction\/\d+\.\d{9}$/);
    }
    console.info(`HTS integration: mint ${result.operations[0].hashscanUrl}`);
    console.info(`HTS integration: transfer ${result.operations[1].hashscanUrl}`);

    // The ledger shows exactly the effects the plan promised: supply +amount, beneficiary +amount.
    const relationship = await until("the beneficiary balance on Mirror Node", async () => {
      const r = await s.mirror.getRelationship(s.beneficiaryId, s.tokenId);
      return r && r.balance === AMOUNT ? r : null;
    });
    expect(relationship.balance).toBe(AMOUNT);
    const token = await until("the new supply on Mirror Node", async () => {
      const t = await s.mirror.getToken(s.tokenId);
      return t && t.totalSupply === supplyBefore + AMOUNT ? t : null;
    });
    expect(token.totalSupply).toBe(supplyBefore + AMOUNT);
  }, 180_000);

  it("the settlement memo is on the real Mirror Node, and a repeat without a ledger sends nothing", async () => {
    const found = await until("the settlement transactions by memo", async () => {
      const txs = await s.mirror.findSettlementTransactions(
        s.operatorId,
        eventKey,
        Math.floor(Date.now() / 1000) - 3600,
      );
      return txs.filter(t => t.result === "SUCCESS").length >= 2 ? txs : null;
    });
    expect(found.map(t => t.step).sort()).toEqual(["mint", "transfer"]);

    const withoutLedger = createHtsSettlementAdapter({
      config: s.config,
      executor: s.executor,
      timeoutMs: 60_000,
      operatorKeys: (await inspectPrivateKey(s.env.HEDERA_OPERATOR_KEY ?? "")) ?? [],
    });
    const repeat = await withoutLedger.settle(s.input);
    expect(repeat).toMatchObject({ ok: true, status: "already_settled", replay: true, source: "network" });
    const token = await s.mirror.getToken(s.tokenId);
    expect(token?.totalSupply).toBe(supplyBefore + AMOUNT); // still one credit
  }, 180_000);

  it("a repeat with the ledger returns the earlier result, and different content for the same key is refused", async () => {
    expect(await s.adapter.settle(s.input)).toMatchObject({
      ok: true,
      status: "already_settled",
      replay: true,
      source: "ledger",
    });
    const conflicting = await s.adapter.settle({
      ...s.input,
      contentHash: keccak256(toUtf8Bytes("other facts")),
      amount: 999n,
    });
    expect(conflicting).toMatchObject({ ok: false, failure: { code: "CONFLICTING_SETTLEMENT", outcome: "not_sent" } });
  }, 60_000);

  it("reports a token that does not exist as TOKEN_NOT_FOUND from the real Mirror Node", async () => {
    const outcome = await s.adapter.preflight({ ...s.input, tokenId: "0.0.999999999" });
    expect(outcome).toMatchObject({ valid: true, ok: false, failure: { code: "TOKEN_NOT_FOUND" } });
  }, 60_000);
});

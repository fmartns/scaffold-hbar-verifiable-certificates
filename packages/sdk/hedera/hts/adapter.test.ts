import { describe, expect, it, vi } from "vitest";
import { NETWORKS } from "../networks";
import { UNKNOWN_STEP_EXPIRY_MS, createHtsSettlementAdapter, sdkTransactionId } from "./adapter";
import type { HtsAdapterOptions } from "./adapter";
import { HtsError } from "./errors";
import type { HtsExecutor } from "./executor";
import { createInMemoryLedger } from "./ledger";
import { settlementMemo } from "./settlement";
import type { SettlementStatusReader, SettlementSuccess } from "./types";
import type { WorldOptions } from "./test-fixtures";
import {
  BENEFICIARY,
  CONTENT_HASH,
  EVENT_KEY,
  NOW,
  OPERATOR,
  OPERATOR_PUBLIC_KEY,
  ROUTER_CONTRACT,
  SETTLEMENT_ID,
  TOKEN,
  contractKeyHex,
  hederaError,
  makeInput,
  operatorConfig,
  routerConfig,
  timeout,
  world,
} from "./test-fixtures";

function setup(
  options: {
    world?: WorldOptions;
    config?: HtsAdapterOptions["config"];
    ledger?: boolean;
    statusReader?: SettlementStatusReader;
    noExecutor?: boolean;
  } = {},
) {
  const w = world(options.world);
  const clock = { now: new Date(NOW) };
  const ledger = options.ledger ? createInMemoryLedger() : undefined;
  const adapter = createHtsSettlementAdapter({
    config: options.config ?? operatorConfig(),
    mirror: w.mirror,
    executor: options.noExecutor ? undefined : w.executor,
    ledger,
    statusReader: options.statusReader,
    operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
    now: () => clock.now,
    timeoutMs: 1000,
  });
  return { w, adapter, ledger, clock };
}
const ok = (result: unknown) => result as SettlementSuccess;
const failure = (result: unknown) => (result as { failure: import("./errors").HtsFailure }).failure;
const executed = (w: ReturnType<typeof world>) => w.calls.executor.filter(c => !c.startsWith("associate"));

describe("associate", () => {
  const unassociated = () => {
    const s = setup({ noExecutor: false });
    s.w.removeAssociation(BENEFICIARY);
    return s;
  };

  it("associates an account that is not associated yet, and then the settlement preflight passes", async () => {
    const { w, adapter } = unassociated();
    expect((await adapter.preflight(makeInput())).ok).toBe(false);
    const result = await adapter.associate({ accountId: BENEFICIARY });
    expect(result).toMatchObject({
      ok: true,
      status: "associated",
      accountId: BENEFICIARY,
      tokenId: TOKEN,
      network: "testnet",
      hashscanTokenUrl: `https://hashscan.io/testnet/token/${TOKEN}`,
      operation: {
        operation: "associate",
        hashscanUrl: expect.stringMatching(/^https:\/\/hashscan\.io\/testnet\/transaction\/\d+\.\d{9}$/),
      },
    });
    expect(w.isAssociated(BENEFICIARY)).toBe(true);
    expect((await adapter.preflight(makeInput())).ok).toBe(true);
  });

  it("is idempotent: an account Mirror shows as associated is not sent again", async () => {
    const { w, adapter } = setup();
    expect(await adapter.associate({ accountId: BENEFICIARY })).toMatchObject({
      ok: true,
      status: "already_associated",
      operation: null,
    });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("treats the executor's already-associated answer as success", async () => {
    const { w } = unassociated();
    const executor: HtsExecutor = {
      ...w.executor,
      associate: async () => ({ transactionId: "", consensusTimestamp: "", alreadyAssociated: true }),
    };
    const adapter = createHtsSettlementAdapter({ config: operatorConfig(), mirror: w.mirror, executor });
    expect(await adapter.associate({ accountId: BENEFICIARY })).toMatchObject({
      ok: true,
      status: "already_associated",
    });
  });

  it.each([
    ["a token that does not exist", { token: null }, "TOKEN_NOT_FOUND"],
    ["a deleted token", { token: { deleted: true } }, "TOKEN_INVALID"],
  ])("fails for %s, without sending", async (_, worldOptions, code) => {
    const { w, adapter } = setup({ world: worldOptions as WorldOptions });
    expect(failure(await adapter.associate({ accountId: BENEFICIARY }))).toMatchObject({
      code,
      operation: "associate",
    });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("fails for an account that does not exist", async () => {
    const { adapter } = setup();
    expect(failure(await adapter.associate({ accountId: "0.0.424242" }))).toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });

  it("needs an executor", async () => {
    const s = setup({ noExecutor: true });
    s.w.removeAssociation(BENEFICIARY);
    expect(failure(await s.adapter.associate({ accountId: BENEFICIARY }))).toMatchObject({
      code: "CONFIG_INVALID",
      operation: "associate",
    });
  });

  it("reports the account's own key as the missing authority, not a generic error", async () => {
    const { w, adapter } = unassociated();
    w.state.faults.associate = new HtsError({
      code: "ASSOCIATION_NOT_AUTHORIZED",
      outcome: "not_sent",
      operation: "associate",
      message: "m",
      remediation: "r",
      retryable: false,
    });
    expect(failure(await adapter.associate({ accountId: BENEFICIARY }))).toMatchObject({
      code: "ASSOCIATION_NOT_AUTHORIZED",
      outcome: "not_sent",
    });
  });

  it("normalizes a network refusal and a timeout that keeps the transaction id", async () => {
    const { w, adapter } = unassociated();
    w.state.faults.associate = hederaError("PrecheckStatusError", "TOKENS_PER_ACCOUNT_LIMIT_EXCEEDED");
    expect(failure(await adapter.associate({ accountId: BENEFICIARY }))).toMatchObject({
      code: "TRANSACTION_FAILED",
      hederaStatus: "TOKENS_PER_ACCOUNT_LIMIT_EXCEEDED",
    });
    w.state.faults.associate = Object.assign(timeout(), { hvsTransactionId: "0.0.1234@1.1" });
    expect(failure(await adapter.associate({ accountId: BENEFICIARY }))).toMatchObject({
      code: "TIMEOUT",
      outcome: "unknown",
      transactionId: "0.0.1234@1.1",
    });
  });
});

describe("settle: mint-transfer (the ADR v1 model)", () => {
  it("mints the amount and transfers it to the beneficiary, in that order, each tagged with its memo", async () => {
    const { w, adapter } = setup();
    const result = ok(await adapter.settle(makeInput({ amount: 1000n })));
    expect(executed(w)).toEqual(["mint 1000", `transfer 1000 ${OPERATOR}->${BENEFICIARY}`]);
    expect(w.token?.totalSupply).toBe(1000n);
    expect(w.balanceOf(BENEFICIARY)).toBe(1000n);
    expect(w.balanceOf(OPERATOR)).toBe(0n); // the treasury nets zero, as expectedEffects says
    expect(result.operations.map(o => o.operation)).toEqual(["mint", "transfer"]);
    expect(w.transactions.map(t => t.step)).toEqual(["mint", "transfer"]);
  });

  it("returns what an audit and a correlation need", async () => {
    const { adapter } = setup();
    const result = ok(await adapter.settle(makeInput({ amount: "1000" })));
    expect(result).toMatchObject({
      ok: true,
      status: "settled",
      replay: false,
      source: "executed",
      idempotencyKey: EVENT_KEY,
      settlementId: SETTLEMENT_ID,
      contentHash: CONTENT_HASH,
      network: "testnet",
      tokenId: TOKEN,
      model: "mint-transfer",
      custody: "operator",
      from: OPERATOR,
      to: BENEFICIARY,
      amount: "1000",
      hashscanTokenUrl: `https://hashscan.io/testnet/token/${TOKEN}`,
    });
    const [mint, transfer] = result.operations;
    expect(transfer.transactionId).toMatch(/^0\.0\.1234@\d+\.\d{9}$/);
    expect(transfer.mirrorTransactionId).toMatch(/^0\.0\.1234-\d+-\d{9}$/);
    expect(transfer.hashscanUrl).toBe(`https://hashscan.io/testnet/transaction/${transfer.consensusTimestamp}`);
    expect(result.transactionId).toBe(transfer.transactionId);
    expect(result.hashscanUrl).toBe(transfer.hashscanUrl);
    expect(mint.transactionId).not.toBe(transfer.transactionId);
    expect(result.audit).toMatchObject({
      schema: "hts-settlement/v1",
      recordedAt: NOW.toISOString(),
      expectedEffects: { supplyDelta: "1000", balanceDeltas: { [BENEFICIARY]: "1000" } },
      preflight: {
        checks: expect.arrayContaining(["token-exists", "mint-permission", "beneficiary-associated"]),
        warnings: [],
      },
    });
  });

  it("returns JSON-safe data that survives persistence unchanged", async () => {
    const { adapter } = setup();
    const result = ok(await adapter.settle(makeInput()));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("uses the settlement memo of the idempotency key on every transaction", async () => {
    const { w, adapter } = setup();
    await adapter.settle(makeInput());
    // the fake records the memo of each transaction; the scan by memo finds both
    const found = await w.mirror.findSettlementTransactions(OPERATOR, EVENT_KEY, 0);
    expect(found.map(t => t.step)).toEqual(["mint", "transfer"]);
    expect(settlementMemo(EVENT_KEY, "mint")).toMatch(/^hvs:1:0x[0-9a-f]{64}:mint$/);
  });

  it("resolves an EVM-address beneficiary and reports the account id", async () => {
    const { adapter } = setup({
      world: { accounts: { [BENEFICIARY]: { evmAddress: "0x00000000000000000000000000000000000023f9" } } },
    });
    expect(ok(await adapter.settle(makeInput({ beneficiary: "0x00000000000000000000000000000000000023f9" }))).to).toBe(
      BENEFICIARY,
    );
  });

  it("no explorer link on a network without one (local)", async () => {
    const { adapter } = setup({ config: { ...operatorConfig(), network: NETWORKS.local } });
    const result = ok(await adapter.settle(makeInput()));
    expect(result).toMatchObject({ hashscanUrl: null, hashscanTokenUrl: null });
  });
});

describe("settle: pool-transfer (the documented alternative)", () => {
  it("only transfers from the pre-funded treasury: nothing is minted", async () => {
    const { w, adapter } = setup({
      config: operatorConfig({ model: "pool-transfer" }),
      world: { token: { supplyKey: null } },
    });
    w.setRelationship(OPERATOR, { balance: 5000n });
    const result = ok(await adapter.settle(makeInput({ amount: 1000n })));
    expect(executed(w)).toEqual([`transfer 1000 ${OPERATOR}->${BENEFICIARY}`]);
    expect(result.operations.map(o => o.operation)).toEqual(["transfer"]);
    expect(w.token?.totalSupply).toBe(0n);
    expect(w.balanceOf(OPERATOR)).toBe(4000n);
    expect(result.audit.expectedEffects).toEqual({
      supplyDelta: "0",
      balanceDeltas: { [BENEFICIARY]: "1000", [OPERATOR]: "-1000" },
    });
  });

  it("does not send a transfer the pool cannot cover: INSUFFICIENT_BALANCE from the preflight", async () => {
    const { w, adapter } = setup({
      config: operatorConfig({ model: "pool-transfer" }),
      world: { token: { supplyKey: null } },
    });
    w.setRelationship(OPERATOR, { balance: 10n });
    expect(failure(await adapter.settle(makeInput({ amount: 1000n })))).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      outcome: "not_sent",
    });
    expect(w.calls.executor).toHaveLength(0);
  });
});

describe("settle: zero amount (the ADR's valid no-op)", () => {
  it("consumes the key and sends nothing", async () => {
    const { w, adapter } = setup({ ledger: true });
    const result = ok(await adapter.settle(makeInput({ amount: 0n })));
    expect(result).toMatchObject({
      ok: true,
      status: "noop",
      operations: [],
      transactionId: null,
      amount: "0",
      audit: { expectedEffects: { supplyDelta: "0", balanceDeltas: {} } },
    });
    expect(w.calls.executor).toHaveLength(0);
    expect(w.calls.mirror).toHaveLength(0);
  });
});

describe("settle: idempotency (ADR D4/D5, coordinated with the router)", () => {
  it("a repeated settlement with a ledger returns the previous result and sends NOTHING", async () => {
    const { w, adapter, ledger } = setup({ ledger: true });
    const first = ok(await adapter.settle(makeInput()));
    const callsAfterFirst = w.calls.executor.length;
    const second = ok(await adapter.settle(makeInput()));
    expect(second).toMatchObject({
      status: "already_settled",
      replay: true,
      source: "ledger",
      transactionId: first.transactionId,
    });
    expect(second.operations).toEqual(first.operations);
    expect(w.calls.executor).toHaveLength(callsAfterFirst);
    expect(w.token?.totalSupply).toBe(1000n); // one credit, not two
    expect(ledger?.records()).toHaveLength(1);
    expect(ledger?.records()[0]).toMatchObject({
      idempotencyKey: EVENT_KEY,
      state: "completed",
      steps: { mint: { state: "confirmed" }, transfer: { state: "confirmed" } },
    });
  });

  it("without a ledger, the settlement memo on Mirror Node still prevents a second credit", async () => {
    const { w, adapter } = setup();
    const first = ok(await adapter.settle(makeInput()));
    const second = ok(await adapter.settle(makeInput()));
    expect(second).toMatchObject({ status: "already_settled", replay: true, source: "network" });
    expect(second.operations.map(o => o.transactionId)).toEqual(first.operations.map(o => o.transactionId));
    expect(w.token?.totalSupply).toBe(1000n);
    expect(executed(w)).toHaveLength(2);
  });

  it("the router's statusOf is the authority: an event it already settled is never sent again", async () => {
    const statusReader = {
      statusOf: vi.fn(async () => ({ settled: true, contentHash: CONTENT_HASH, settledAt: 1767225600n })),
    };
    const { w, adapter } = setup({ statusReader });
    const result = ok(await adapter.settle(makeInput()));
    expect(result).toMatchObject({
      status: "already_settled",
      replay: true,
      source: "router",
      operations: [],
      audit: { routerSettledAt: "1767225600" },
    });
    expect(statusReader.statusOf).toHaveBeenCalledWith(EVENT_KEY);
    expect(w.calls.executor).toHaveLength(0);
    expect(w.calls.mirror).toHaveLength(0); // not even a preflight: the router already answered
  });

  it("the router settled DIFFERENT content for this key: CONFLICTING_SETTLEMENT, never executed", async () => {
    const statusReader = {
      statusOf: async () => ({ settled: true, contentHash: `0x${"dd".repeat(32)}`, settledAt: 5n }),
    };
    const { w, adapter } = setup({ statusReader });
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      code: "CONFLICTING_SETTLEMENT",
      outcome: "not_sent",
      retryable: false,
      idempotencyKey: EVENT_KEY,
    });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("an unsettled event on the router proceeds", async () => {
    const statusReader = {
      statusOf: async () => ({ settled: false, contentHash: `0x${"00".repeat(32)}`, settledAt: 0n }),
    };
    const { adapter } = setup({ statusReader });
    expect(ok(await adapter.settle(makeInput())).status).toBe("settled");
  });

  it("the same key with different content in the ledger is a conflict, not a retry", async () => {
    const { w, adapter } = setup({ ledger: true });
    await adapter.settle(makeInput());
    const conflicting = await adapter.settle(makeInput({ contentHash: `0x${"ee".repeat(32)}`, amount: 2000n }));
    expect(failure(conflicting)).toMatchObject({ code: "CONFLICTING_SETTLEMENT", outcome: "not_sent" });
    expect(w.token?.totalSupply).toBe(1000n);
  });

  it("a different event key is a different settlement", async () => {
    const { w, adapter } = setup({ ledger: true });
    await adapter.settle(makeInput());
    await adapter.settle(makeInput({ eventKey: `0x${"12".repeat(32)}`, settlementId: `0x${"13".repeat(32)}` }));
    expect(w.token?.totalSupply).toBe(2000n);
  });

  it("two identical calls at the same moment in one process are one execution", async () => {
    const { w, adapter } = setup({ ledger: true });
    const [a, b] = await Promise.all([adapter.settle(makeInput()), adapter.settle(makeInput())]);
    expect(a).toEqual(b);
    expect(executed(w)).toHaveLength(2);
    expect(w.token?.totalSupply).toBe(1000n);
  });

  it("two processes sharing a ledger cannot both send: the second sees the claim", async () => {
    const w = world();
    const ledger = createInMemoryLedger();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    const slow: HtsExecutor = { ...w.executor, mint: async r => (await gate, w.executor.mint(r)) };
    const build = (executor: HtsExecutor) =>
      createHtsSettlementAdapter({
        config: operatorConfig(),
        mirror: w.mirror,
        executor,
        ledger,
        operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
        now: () => NOW,
        timeoutMs: 5000,
      });
    const first = build(slow).settle(makeInput());
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await build(w.executor).settle(makeInput());
    expect(failure(second)).toMatchObject({ code: "SETTLEMENT_IN_PROGRESS", outcome: "unknown", retryable: true });
    expect(w.calls.executor.filter(c => c.startsWith("mint"))).toHaveLength(0); // the second sent nothing
    release();
    expect(ok(await first).status).toBe("settled");
    expect(ok(await build(w.executor).settle(makeInput()))).toMatchObject({
      status: "already_settled",
      source: "ledger",
    });
    expect(w.token?.totalSupply).toBe(1000n);
  });

  describe("a legitimate retry versus a duplicate", () => {
    it("a settlement refused by a precondition (not sent) can be retried after the cause is fixed", async () => {
      const { w, adapter, ledger } = setup({ ledger: true });
      w.removeAssociation(BENEFICIARY);
      expect(failure(await adapter.settle(makeInput()))).toMatchObject({
        code: "NOT_ASSOCIATED",
        outcome: "not_sent",
        retryable: true,
      });
      expect(w.calls.executor).toHaveLength(0);
      expect(ledger?.records()).toHaveLength(0); // nothing was claimed
      await adapter.associate({ accountId: BENEFICIARY });
      expect(ok(await adapter.settle(makeInput())).status).toBe("settled");
    });

    it("a transfer rejected AFTER the mint is partial, and the retry sends only the transfer", async () => {
      const { w, adapter, ledger } = setup({ ledger: true });
      w.state.faults.transfer = hederaError("ReceiptStatusError", "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
      const partial = failure(await adapter.settle(makeInput()));
      expect(partial).toMatchObject({ code: "NOT_ASSOCIATED", outcome: "partial", operation: "transfer" });
      expect(partial.appliedTransactions).toHaveLength(1);
      expect(w.token?.totalSupply).toBe(1000n); // supply grew: the mint is applied
      expect(w.balanceOf(BENEFICIARY)).toBe(0n);
      expect(ledger?.records()[0]).toMatchObject({
        state: "failed",
        steps: { mint: { state: "confirmed" }, transfer: { state: "rejected" } },
      });

      const retried = ok(await adapter.settle(makeInput()));
      expect(retried.status).toBe("settled");
      expect(w.calls.executor.filter(c => c.startsWith("mint"))).toHaveLength(1); // the mint was NOT repeated
      expect(w.token?.totalSupply).toBe(1000n);
      expect(w.balanceOf(BENEFICIARY)).toBe(1000n);
      expect(retried.operations.map(o => o.operation)).toEqual(["mint", "transfer"]);
    });

    it("the partial retry also works without a ledger, by finding the mint through its memo", async () => {
      const { w, adapter } = setup();
      w.state.faults.transfer = hederaError("ReceiptStatusError", "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
      await adapter.settle(makeInput());
      expect(ok(await adapter.settle(makeInput())).status).toBe("settled");
      expect(w.calls.executor.filter(c => c.startsWith("mint"))).toHaveLength(1);
      expect(w.token?.totalSupply).toBe(1000n);
    });

    it("a preflight failure after the mint is applied is reported as partial too, so nobody thinks nothing happened", async () => {
      const { w, adapter } = setup({ ledger: true });
      w.state.faults.transfer = hederaError("ReceiptStatusError", "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
      await adapter.settle(makeInput());
      w.removeAssociation(BENEFICIARY); // the beneficiary is still not associated
      const again = failure(await adapter.settle(makeInput()));
      expect(again).toMatchObject({ code: "NOT_ASSOCIATED", outcome: "partial" });
      expect(again.appliedTransactions).toHaveLength(1);
      expect(w.calls.executor.filter(c => c.startsWith("mint"))).toHaveLength(1);
    });

    it("a rejected mint applied nothing and is a plain retry", async () => {
      const { w, adapter } = setup({ ledger: true });
      w.state.faults.mint = hederaError("PrecheckStatusError", "INVALID_SIGNATURE");
      expect(failure(await adapter.settle(makeInput()))).toMatchObject({
        code: "NO_MINT_PERMISSION",
        outcome: "rejected",
        operation: "mint",
      });
      expect(w.token?.totalSupply).toBe(0n);
      expect(ok(await adapter.settle(makeInput())).status).toBe("settled");
      expect(w.token?.totalSupply).toBe(1000n);
    });
  });

  it("writes the step to the ledger as `sent` BEFORE sending it, so a crash mid-send leaves a trace", async () => {
    const w = world();
    const ledger = createInMemoryLedger();
    let seenDuringMint: unknown;
    const spying: HtsExecutor = {
      ...w.executor,
      mint: async r => {
        seenDuringMint = (await ledger.get(EVENT_KEY))?.steps.mint;
        return w.executor.mint(r);
      },
    };
    const adapter = createHtsSettlementAdapter({
      config: operatorConfig(),
      mirror: w.mirror,
      executor: spying,
      ledger,
      operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
      now: () => NOW,
      timeoutMs: 1000,
    });
    await adapter.settle(makeInput());
    expect(seenDuringMint).toMatchObject({ operation: "mint", state: "sent", sentAt: NOW.toISOString() });
  });

  it("losing the race for the claim (another process began first) sends nothing", async () => {
    const w = world();
    const inner = createInMemoryLedger();
    // `get` sees nothing, but by the time this process calls `begin` another one has already claimed the key.
    const racing = {
      ...inner,
      begin: async (record: Parameters<typeof inner.begin>[0]) => {
        await inner.begin({ ...record, contentHash: record.contentHash });
        return inner.begin(record);
      },
    };
    const adapter = createHtsSettlementAdapter({
      config: operatorConfig(),
      mirror: w.mirror,
      executor: w.executor,
      ledger: racing,
      operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
      now: () => NOW,
      timeoutMs: 1000,
    });
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      code: "SETTLEMENT_IN_PROGRESS",
      outcome: "unknown",
    });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("a mint that only the ledger knows (Mirror Node is lagging) is not minted again on the retry, even though it used all the supply", async () => {
    const { w, adapter, ledger } = setup({
      ledger: true,
      world: { token: { supplyType: "FINITE", maxSupply: 1000n } },
    });
    w.state.lag = true; // nothing the executor does is visible on Mirror Node yet
    w.state.faults.transfer = hederaError("ReceiptStatusError", "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
    await adapter.settle(makeInput());
    expect(ledger?.records()[0].steps.mint?.state).toBe("confirmed");
    expect(await w.mirror.findSettlementTransactions(OPERATOR, EVENT_KEY, 0)).toHaveLength(0);

    const retried = ok(await adapter.settle(makeInput()));
    expect(retried.status).toBe("settled");
    expect(w.calls.executor.filter(c => c.startsWith("mint"))).toHaveLength(1); // trusted the ledger, not the lagging Mirror
    expect(w.token?.totalSupply).toBe(1000n);
    expect(retried.operations.map(o => o.operation)).toEqual(["mint", "transfer"]);
  });

  describe("an unknown outcome is never blindly resent", () => {
    /** The transfer is applied on the ledger, but the caller sees a timeout (and Mirror Node has not caught up). */
    function appliedButTimedOut() {
      const s = setup({ ledger: true });
      s.w.state.lag = true;
      const inner = s.w.executor.transfer;
      const adapter = createHtsSettlementAdapter({
        config: operatorConfig(),
        mirror: s.w.mirror,
        ledger: s.ledger,
        operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
        now: () => s.clock.now,
        timeoutMs: 1000,
        executor: {
          ...s.w.executor,
          transfer: async r => {
            await inner(r);
            throw timeout();
          },
        },
      });
      return { ...s, adapter };
    }

    it("returns TIMEOUT / unknown with the transaction id and does not resend", async () => {
      const { w, adapter, ledger } = appliedButTimedOut();
      const first = failure(await adapter.settle(makeInput()));
      expect(first).toMatchObject({ code: "TIMEOUT", outcome: "unknown", retryable: true, operation: "transfer" });
      expect(first.transactionId).toMatch(/^0\.0\.1234@/);
      expect(ledger?.records()[0]).toMatchObject({
        state: "unknown",
        steps: { transfer: { state: "unknown", transactionId: first.transactionId } },
      });
      const callsBefore = w.calls.executor.length;

      const again = failure(await adapter.settle(makeInput()));
      expect(again).toMatchObject({ code: "SETTLEMENT_IN_PROGRESS", outcome: "unknown", operation: "transfer" });
      expect(w.calls.executor).toHaveLength(callsBefore); // NOTHING was sent
    });

    it("once Mirror Node shows it, the retry completes from the network without sending", async () => {
      const { w, adapter, ledger } = appliedButTimedOut();
      await adapter.settle(makeInput());
      w.flush();
      const callsBefore = w.calls.executor.length;
      const done = ok(await adapter.settle(makeInput()));
      expect(done).toMatchObject({ status: "already_settled", source: "network", replay: true });
      expect(done.operations.map(o => o.operation)).toEqual(["mint", "transfer"]);
      expect(w.calls.executor).toHaveLength(callsBefore);
      expect(w.token?.totalSupply).toBe(1000n);
      expect(ledger?.records()[0].state).toBe("completed");
    });

    it("after the transaction has certainly expired (it never appeared), the retry may send again", async () => {
      const s = setup({ ledger: true });
      const dropped: HtsExecutor = {
        ...s.w.executor,
        transfer: async r => {
          r.onTransactionId("0.0.1234@1.1");
          throw timeout();
        },
      };
      const adapter = createHtsSettlementAdapter({
        config: operatorConfig(),
        mirror: s.w.mirror,
        ledger: s.ledger,
        executor: dropped,
        operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
        now: () => s.clock.now,
        timeoutMs: 1000,
      });
      await adapter.settle(makeInput());
      expect(failure(await adapter.settle(makeInput())).code).toBe("SETTLEMENT_IN_PROGRESS");
      s.clock.now = new Date(NOW.getTime() + UNKNOWN_STEP_EXPIRY_MS + 1000);
      const healthy = createHtsSettlementAdapter({
        config: operatorConfig(),
        mirror: s.w.mirror,
        ledger: s.ledger,
        executor: s.w.executor,
        operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
        now: () => s.clock.now,
        timeoutMs: 1000,
      });
      expect(ok(await healthy.settle(makeInput())).status).toBe("settled");
      expect(s.w.token?.totalSupply).toBe(1000n); // the mint of the first attempt was reused: one credit
    });

    it("a process that died mid-send leaves a claim that blocks an immediate retry, and expires later", async () => {
      const { w, adapter, ledger, clock } = setup({ ledger: true });
      const at = NOW.toISOString();
      await ledger?.begin({
        idempotencyKey: EVENT_KEY,
        settlementId: SETTLEMENT_ID,
        contentHash: CONTENT_HASH,
        state: "in_progress",
        steps: { mint: { operation: "mint", state: "sent", sentAt: at } },
        createdAt: at,
        updatedAt: at,
      });
      expect(failure(await adapter.settle(makeInput())).code).toBe("SETTLEMENT_IN_PROGRESS");
      expect(w.calls.executor).toHaveLength(0);
      clock.now = new Date(NOW.getTime() + UNKNOWN_STEP_EXPIRY_MS + 1000);
      expect(ok(await adapter.settle(makeInput())).status).toBe("settled");
    });

    it("another attempt's fresh claim blocks; a stale one (crashed process) does not", async () => {
      const { w, adapter, ledger, clock } = setup({ ledger: true });
      const at = NOW.toISOString();
      await ledger?.begin({
        idempotencyKey: EVENT_KEY,
        settlementId: SETTLEMENT_ID,
        contentHash: CONTENT_HASH,
        state: "in_progress",
        steps: {},
        createdAt: at,
        updatedAt: at,
      });
      expect(failure(await adapter.settle(makeInput()))).toMatchObject({ code: "SETTLEMENT_IN_PROGRESS" });
      expect(w.calls.executor).toHaveLength(0);
      clock.now = new Date(NOW.getTime() + UNKNOWN_STEP_EXPIRY_MS + 1000);
      expect(ok(await adapter.settle(makeInput())).status).toBe("settled");
    });
  });
});

describe("settle: HTS errors are specific, not generic", () => {
  it.each([
    [
      "the account is not associated",
      (w: ReturnType<typeof world>) => w.removeAssociation(BENEFICIARY),
      "NOT_ASSOCIATED",
    ],
    ["the token does not exist", null, "TOKEN_NOT_FOUND"],
  ])("%s -> %s before anything is sent", async (_, mutate, code) => {
    const { w, adapter } = setup({ world: mutate ? {} : { token: null } });
    mutate?.(w);
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({ code, outcome: "not_sent" });
    expect(w.calls.executor).toHaveLength(0);
  });

  it.each([
    [
      "the operator does not hold the supply key",
      { token: { supplyKey: { type: "ED25519" as const, key: "cd".repeat(32) } } },
      "NO_MINT_PERMISSION",
    ],
    ["the token has no supply key", { token: { supplyKey: null } }, "NO_MINT_PERMISSION"],
    ["the token is paused", { token: { paused: true } }, "TOKEN_PAUSED"],
    ["the token was deleted", { token: { deleted: true } }, "TOKEN_INVALID"],
    [
      "the supply cap would be exceeded",
      { token: { supplyType: "FINITE" as const, maxSupply: 10n } },
      "SUPPLY_EXCEEDED",
    ],
    [
      "the beneficiary is frozen",
      { associated: { [BENEFICIARY]: { freezeStatus: "FROZEN" as const } } },
      "ACCOUNT_FROZEN",
    ],
  ])("%s -> %s before anything is sent", async (_, worldOptions, code) => {
    const { w, adapter } = setup({ world: worldOptions as WorldOptions });
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      code,
      outcome: "not_sent",
      operation: "preflight",
    });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("the preflight's failure lists the checks that were evaluated", async () => {
    const { adapter, w } = setup();
    w.removeAssociation(BENEFICIARY);
    const f = failure(await adapter.settle(makeInput()));
    expect(f.checks?.map(c => c.id)).toContain("beneficiary-associated");
    expect(f.checks?.find(c => c.id === "beneficiary-associated")).toMatchObject({ ok: false, code: "NOT_ASSOCIATED" });
  });

  it("an invalid input is INVALID_SETTLEMENT with the fields, and nothing runs", async () => {
    const { w, adapter } = setup();
    const f = failure(await adapter.settle({ eventKey: "0x12", tokenId: "x", beneficiary: "y", amount: -5 }));
    expect(f).toMatchObject({ code: "INVALID_SETTLEMENT", outcome: "not_sent" });
    expect(f.issues?.map(i => i.field)).toEqual(
      expect.arrayContaining(["eventKey", "tokenId", "beneficiary", "amount"]),
    );
    expect(w.calls.mirror).toHaveLength(0);
  });

  it.each([
    ["INSUFFICIENT_TOKEN_BALANCE", "INSUFFICIENT_BALANCE"],
    ["TOKEN_IS_PAUSED", "TOKEN_PAUSED"],
    ["ACCOUNT_FROZEN_FOR_TOKEN", "ACCOUNT_FROZEN"],
    ["SPENDER_DOES_NOT_HAVE_ALLOWANCE", "INSUFFICIENT_ALLOWANCE"],
    ["INVALID_TOKEN_ID", "TOKEN_NOT_FOUND"],
  ])("a stale Mirror view: the network rejects with %s and it is still normalized as %s", async (status, code) => {
    const { w, adapter } = setup({
      config: operatorConfig({ model: "pool-transfer" }),
      world: { token: { supplyKey: null } },
    });
    w.setRelationship(OPERATOR, { balance: 5000n });
    w.state.faults.transfer = hederaError("ReceiptStatusError", status);
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      code,
      hederaStatus: status,
      outcome: "rejected",
      operation: "transfer",
    });
  });

  it("a network failure before anything left is not_sent; the executor is called once, never retried", async () => {
    const { w, adapter } = setup();
    w.state.faults.mint = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "not_sent",
      retryable: true,
      operation: "mint",
    });
    expect(w.calls.executor).toEqual(["mint 1000"]);
  });

  it("Mirror Node down: the preflight fails as NETWORK_UNAVAILABLE and nothing is sent", async () => {
    const { w, adapter } = setup();
    w.state.mirrorDown = true;
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "not_sent",
    });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("the router unreachable: the settlement is not sent blind", async () => {
    const statusReader = {
      statusOf: async () => {
        throw new HtsError({
          code: "NETWORK_UNAVAILABLE",
          outcome: "not_sent",
          operation: "preflight",
          message: "m",
          remediation: "r",
          retryable: true,
        });
      },
    };
    const { w, adapter } = setup({ statusReader });
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "not_sent",
    });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("stamps every failure with the idempotency key and the settlement id for correlation", async () => {
    const { w, adapter } = setup();
    w.removeAssociation(BENEFICIARY);
    expect(failure(await adapter.settle(makeInput()))).toMatchObject({
      idempotencyKey: EVENT_KEY,
      settlementId: SETTLEMENT_ID,
      tokenId: TOKEN,
    });
  });

  it("does not leak keys or raw SDK text into any result", async () => {
    const { w, adapter } = setup();
    w.state.faults.mint = hederaError(
      "PrecheckStatusError",
      "INVALID_SIGNATURE",
      "operator key 302e020100300506032b657004220420deadbeef",
    );
    const text = JSON.stringify(await adapter.settle(makeInput()));
    expect(text).not.toMatch(/deadbeef|302e0201/);
  });

  it("never writes to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(m =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { w, adapter } = setup({ ledger: true });
    await adapter.settle(makeInput());
    w.state.faults.mint = new Error("boom");
    await adapter.settle(makeInput({ eventKey: `0x${"77".repeat(32)}` }));
    expect(spies.every(s => s.mock.calls.length === 0)).toBe(true);
    spies.forEach(s => s.mockRestore());
  });
});

describe("router custody (ADR v1 production): the router settles on-chain", () => {
  // A token that is correctly set up for the router: only the guard can stop this from being executed off-chain.
  const routerReady = () =>
    setup({
      config: routerConfig(),
      world: {
        token: {
          treasuryAccountId: ROUTER_CONTRACT,
          supplyKey: { type: "ProtobufEncoded", key: contractKeyHex(7000) },
        },
      },
    });

  it("refuses to execute the settlement off-chain even when everything is in place, and says who does", async () => {
    const { w, adapter } = routerReady();
    expect((await adapter.preflight(makeInput())).ok).toBe(true); // the relayer's preflight is fine...
    const f = failure(await adapter.settle(makeInput())); //          ...but this process must not settle
    expect(f).toMatchObject({ code: "CONFIG_INVALID", outcome: "not_sent", operation: "settle" });
    expect(f.message).toMatch(/mints and transfers on-chain/);
    expect(f.remediation).toMatch(/SettlementRouter/);
    expect(w.calls.executor).toHaveLength(0);
  });

  it("needs an executor to execute under operator custody", async () => {
    const { adapter } = setup({ noExecutor: true });
    expect(failure(await adapter.settle(makeInput())).message).toMatch(/No executor/);
  });
});

describe("preflight and checkSetup (what a relayer runs before SettlementRouter.settle)", () => {
  it("preflight sends nothing and returns the checks", async () => {
    const { w, adapter } = setup();
    const outcome = await adapter.preflight(makeInput());
    expect(outcome).toMatchObject({ valid: true, ok: true, association: "associated" });
    expect(w.calls.executor).toHaveLength(0);
  });

  it("preflight of an invalid input is invalid with the issues", async () => {
    const { adapter } = setup();
    const outcome = await adapter.preflight({});
    expect(outcome).toMatchObject({ valid: false, ok: false, failure: { code: "INVALID_SETTLEMENT" } });
  });

  it("preflight reports the specific failure for a beneficiary that is not associated", async () => {
    const { w, adapter } = setup();
    w.removeAssociation(BENEFICIARY);
    expect(await adapter.preflight(makeInput())).toMatchObject({
      valid: true,
      ok: false,
      failure: { code: "NOT_ASSOCIATED", idempotencyKey: EVENT_KEY },
    });
  });

  it("preflight turns a Mirror outage into a normalized failure", async () => {
    const { w, adapter } = setup();
    w.state.mirrorDown = true;
    expect(await adapter.preflight(makeInput())).toMatchObject({
      valid: false,
      failure: { code: "NETWORK_UNAVAILABLE" },
    });
  });

  it("checkSetup validates the token and the custody without a beneficiary", async () => {
    expect(await setup().adapter.checkSetup()).toMatchObject({ ok: true });
    expect(await setup({ world: { token: null } }).adapter.checkSetup()).toMatchObject({
      ok: false,
      failure: { code: "TOKEN_NOT_FOUND" },
    });
    const down = setup();
    down.w.state.mirrorDown = true;
    expect(await down.adapter.checkSetup()).toMatchObject({ ok: false, failure: { code: "NETWORK_UNAVAILABLE" } });
  });
});

describe("helpers", () => {
  it("sdkTransactionId converts the Mirror format back", () => {
    expect(sdkTransactionId("0.0.9-1712345678-123456789")).toBe("0.0.9@1712345678.123456789");
    expect(sdkTransactionId("weird")).toBe("weird");
  });
});

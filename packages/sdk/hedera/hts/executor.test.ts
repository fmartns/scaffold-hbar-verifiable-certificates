import { describe, expect, it } from "vitest";
import { HtsError } from "./errors";
import { createHieroHtsExecutor } from "./executor";
import type { HieroHtsSdkLike, HtsTransactionLike } from "./executor";
import { OPERATOR, TOKEN, hederaError } from "./test-fixtures";

const TX_ID = "0.0.1234@1767225600.000000001";

/** A fake of the SDK transactions the executor uses. `behaviour` decides how they end. */
function fakeSdk(behaviour: { executeError?: Error; recordError?: Error } = {}) {
  const log: {
    type: string;
    memo?: string;
    regenerate?: boolean;
    maxAttempts?: number;
    deadline?: number;
    signedWith: unknown[];
    fields: Record<string, unknown>;
  }[] = [];
  const trace: string[] = [];
  class Fake implements HtsTransactionLike {
    transactionId: { toString(): string } | null = null;
    entry: (typeof log)[number];
    constructor(type: string) {
      this.entry = { type, signedWith: [], fields: {} };
      log.push(this.entry);
    }
    setTransactionMemo(m: string) {
      this.entry.memo = m;
      return this;
    }
    setRegenerateTransactionId(r: boolean) {
      this.entry.regenerate = r;
      return this;
    }
    setMaxAttempts(n: number) {
      this.entry.maxAttempts = n;
      return this;
    }
    setGrpcDeadline(ms: number) {
      this.entry.deadline = ms;
      return this;
    }
    freezeWith() {
      trace.push("freeze");
      this.transactionId = { toString: () => TX_ID };
      return this;
    }
    async sign(key: unknown) {
      this.entry.signedWith.push(key);
      return this;
    }
    async execute() {
      trace.push("execute");
      if (behaviour.executeError) throw behaviour.executeError;
      return {
        transactionId: { toString: () => TX_ID },
        async getRecord() {
          trace.push("record");
          if (behaviour.recordError) throw behaviour.recordError;
          return {
            transactionId: { toString: () => TX_ID },
            consensusTimestamp: { seconds: { toString: () => "1767225605" }, nanos: { toString: () => "42" } },
          };
        },
      };
    }
  }
  const sdk = {
    TokenAssociateTransaction: class extends Fake {
      constructor() {
        super("associate");
      }
      setAccountId(a: string) {
        this.entry.fields.accountId = a;
        return this;
      }
      setTokenIds(t: string[]) {
        this.entry.fields.tokenIds = t;
        return this;
      }
    },
    TokenMintTransaction: class extends Fake {
      constructor() {
        super("mint");
      }
      setTokenId(t: string) {
        this.entry.fields.tokenId = t;
        return this;
      }
      setAmount(a: bigint) {
        this.entry.fields.amount = a;
        return this;
      }
    },
    TransferTransaction: class extends Fake {
      constructor() {
        super("transfer");
      }
      addTokenTransfer(t: string, a: string, amount: bigint) {
        ((this.entry.fields.transfers as unknown[]) ??= []).push([t, a, amount]);
        return this;
      }
    },
  } as unknown as HieroHtsSdkLike;
  return { sdk, log, trace };
}

const request = (ids: string[] = []) => ({
  memo: "hvs:1:memo",
  timeoutMs: 30_000,
  onTransactionId: (id: string) => ids.push(id),
});
const make = (sdk: HieroHtsSdkLike, accountKeys?: Record<string, unknown>) =>
  createHieroHtsExecutor({ client: {}, operatorId: OPERATOR, accountKeys, sdk });

describe("createHieroHtsExecutor", () => {
  it("mint: sends one TokenMint with the memo and returns the id and consensus timestamp of the record", async () => {
    const { sdk, log } = fakeSdk();
    const ids: string[] = [];
    const receipt = await make(sdk).mint({ ...request(ids), tokenId: TOKEN, amount: 1000n });
    expect(receipt).toEqual({ transactionId: TX_ID, consensusTimestamp: "1767225605.000000042" }); // nanos padded to 9 digits
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: "mint", memo: "hvs:1:memo", fields: { tokenId: TOKEN, amount: 1000n } });
    expect(ids[0]).toBe(TX_ID);
  });

  it("transfer: debits the payer and credits the beneficiary in ONE transaction (the pair sums to zero)", async () => {
    const { sdk, log } = fakeSdk();
    await make(sdk).transfer({ ...request(), tokenId: TOKEN, from: OPERATOR, to: "0.0.9001", amount: 1000n });
    expect(log[0].fields.transfers).toEqual([
      [TOKEN, OPERATOR, -1000n],
      [TOKEN, "0.0.9001", 1000n],
    ]);
  });

  it("never regenerates the transaction id, so an SDK-internal retry cannot create a second effect", async () => {
    const { sdk, log } = fakeSdk();
    await make(sdk).mint({ ...request(), tokenId: TOKEN, amount: 1n });
    expect(log[0]).toMatchObject({ regenerate: false, maxAttempts: 3, deadline: 15_000 });
  });

  it("reports the transaction id BEFORE sending, so a failed send can be reconciled", async () => {
    const { sdk, trace } = fakeSdk({ executeError: new Error("connect ECONNREFUSED") });
    const ids: string[] = [];
    await expect(make(sdk).mint({ ...request(ids), tokenId: TOKEN, amount: 1n })).rejects.toThrow();
    expect(ids).toEqual([TX_ID]);
    expect(trace).toEqual(["freeze", "execute"]);
  });

  it("propagates receipt errors untouched, for the adapter to classify", async () => {
    const boom = hederaError("ReceiptStatusError", "INSUFFICIENT_TOKEN_BALANCE");
    const { sdk } = fakeSdk({ recordError: boom });
    await expect(
      make(sdk).transfer({ ...request(), tokenId: TOKEN, from: OPERATOR, to: "0.0.9", amount: 1n }),
    ).rejects.toBe(boom);
  });

  describe("associate", () => {
    it("associates the operator's own account without another key", async () => {
      const { sdk, log } = fakeSdk();
      const receipt = await make(sdk).associate({ ...request(), accountId: OPERATOR, tokenId: TOKEN });
      expect(receipt).toMatchObject({ transactionId: TX_ID, alreadyAssociated: false });
      expect(log[0]).toMatchObject({
        type: "associate",
        fields: { accountId: OPERATOR, tokenIds: [TOKEN] },
        signedWith: [],
      });
    });

    it("signs another account's association with ITS key when this process holds it", async () => {
      const { sdk, log } = fakeSdk();
      await make(sdk, { "0.0.9001": "KEY-OBJECT" }).associate({ ...request(), accountId: "0.0.9001", tokenId: TOKEN });
      expect(log[0].signedWith).toEqual(["KEY-OBJECT"]);
    });

    it("refuses, before sending anything, when another account's key is not held", async () => {
      const { sdk, log } = fakeSdk();
      const error = await make(sdk)
        .associate({ ...request(), accountId: "0.0.9001", tokenId: TOKEN })
        .catch(e => e);
      expect(error).toBeInstanceOf(HtsError);
      expect(error.failure).toMatchObject({
        code: "ASSOCIATION_NOT_AUTHORIZED",
        outcome: "not_sent",
        accountId: "0.0.9001",
      });
      expect(error.failure.remediation).toMatch(/wallet|its own|supply that account's key/i);
      expect(log).toHaveLength(0);
    });

    it("is idempotent: associating twice is not a failure", async () => {
      const { sdk } = fakeSdk({
        recordError: Object.assign(hederaError("ReceiptStatusError", "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT"), {
          transactionId: { toString: () => TX_ID },
        }),
      });
      expect(await make(sdk).associate({ ...request(), accountId: OPERATOR, tokenId: TOKEN })).toEqual({
        transactionId: TX_ID,
        consensusTimestamp: "",
        alreadyAssociated: true,
      });
    });

    it("propagates any other association error", async () => {
      const { sdk } = fakeSdk({ recordError: hederaError("ReceiptStatusError", "INVALID_TOKEN_ID") });
      await expect(make(sdk).associate({ ...request(), accountId: OPERATOR, tokenId: TOKEN })).rejects.toThrow();
    });
  });
});

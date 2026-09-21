import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { HTS_ENV } from "./config";
import {
  DEFAULT_DECIMALS,
  DEFAULT_POOL_INITIAL_SUPPLY,
  createHieroTokenCreator,
  provisionHtsToken,
} from "./token-create";
import type { HieroTokenSdkLike, TokenCreateTransactionLike, TokenCreator } from "./token-create";
import { OPERATOR, OPERATOR_PUBLIC_KEY, TOKEN, hederaError } from "./test-fixtures";

const FIXED_TX_ID = `${OPERATOR}@1767225600.123456789`;
const inspectKey = async () => [{ type: "ED25519" as const, publicKey: OPERATOR_PUBLIC_KEY }];
const NEW_TOKEN = "0.0.8888";

const baseEnv = (extra: Record<string, string> = {}) => ({
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: OPERATOR,
  HEDERA_OPERATOR_KEY: "ef".repeat(32),
  ...extra,
});

/** In-memory Mirror Node: the account, and tokens that appear after `after` lookups. */
function fakeMirror(
  opts: {
    tokens?: Record<string, { treasury?: string; supplyKey?: string | null; deleted?: boolean; after?: number }>;
    rate?: boolean;
    fee?: number;
  } = {},
) {
  const looks: Record<string, number> = {};
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname.startsWith("/api/v1/accounts/")) {
      return new Response(
        `{"account":"${OPERATOR}","deleted":false,"balance":{"balance":100000000000,"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${OPERATOR_PUBLIC_KEY}"}}`,
      );
    }
    if (url.pathname === "/api/v1/network/exchangerate") {
      return opts.rate
        ? new Response(JSON.stringify({ current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } }))
        : new Response("", { status: 503 });
    }
    if (url.pathname.startsWith("/api/v1/transactions/")) {
      return opts.fee === undefined
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ transactions: [{ charged_tx_fee: opts.fee }] }));
    }
    const id = url.pathname.split("/").pop() ?? "";
    const token = opts.tokens?.[id];
    looks[id] = (looks[id] ?? 0) + 1;
    if (!token || looks[id] <= (token.after ?? 0)) return new Response("", { status: 404 });
    const supplyKey = token.supplyKey === undefined ? OPERATOR_PUBLIC_KEY : token.supplyKey;
    return new Response(
      JSON.stringify({
        token_id: id,
        type: "FUNGIBLE_COMMON",
        deleted: token.deleted ?? false,
        pause_status: "UNPAUSED",
        supply_type: "INFINITE",
        max_supply: "0",
        total_supply: "0",
        treasury_account_id: token.treasury ?? OPERATOR,
        decimals: "0",
        supply_key: supplyKey ? { _type: "ED25519", key: supplyKey } : null,
        symbol: "HVS",
      }),
    );
  }) as typeof fetch;
  return { impl, calls, looks };
}

function fakeCreator(behaviour?: (r: Parameters<TokenCreator["create"]>[0]) => Promise<never> | void) {
  const requests: Parameters<TokenCreator["create"]>[0][] = [];
  const creator: TokenCreator = {
    async create(request) {
      requests.push(request);
      request.onTransactionId(FIXED_TX_ID);
      await behaviour?.(request);
      return { tokenId: NEW_TOKEN, transactionId: FIXED_TX_ID };
    },
  };
  return { creator, requests };
}

const run = (env: Record<string, string>, mirror: ReturnType<typeof fakeMirror>, extra: Record<string, unknown> = {}) =>
  provisionHtsToken(env, { fetch: mirror.impl, inspectKey, sleep: async () => undefined, verifyDelayMs: 0, ...extra });

describe("provisionHtsToken, mint-transfer (the ADR v1 default)", () => {
  it("creates the token with the operator as treasury and supply key, confirms it on Mirror and returns the .env line", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror({ tokens: { [NEW_TOKEN]: {} } });
    const result = await run(baseEnv(), mirror, { creator });
    expect(result).toMatchObject({
      ok: true,
      status: "created",
      network: "testnet",
      tokenId: NEW_TOKEN,
      transactionId: FIXED_TX_ID,
      envLines: [`${HTS_ENV.TOKEN_ID}=${NEW_TOKEN}`],
      hashscanTokenUrl: `https://hashscan.io/testnet/token/${NEW_TOKEN}`,
      verified: true,
      supplyKey: true,
      adminKey: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      name: "Verifiable Settlement Credit",
      symbol: "HVS",
      decimals: DEFAULT_DECIMALS,
      initialSupply: 0n,
      withSupplyKey: true,
      withAdminKey: false,
    });
  });

  it("waits for Mirror Node to index the new token", async () => {
    const { creator } = fakeCreator();
    const mirror = fakeMirror({ tokens: { [NEW_TOKEN]: { after: 3 } } });
    expect(await run(baseEnv(), mirror, { creator })).toMatchObject({ ok: true, verified: true });
    expect(mirror.looks[NEW_TOKEN]).toBe(4);
  });

  it("still succeeds, with a warning, when Mirror Node never shows the token in time", async () => {
    const { creator } = fakeCreator();
    const result = await run(baseEnv(), fakeMirror(), { creator, verifyAttempts: 3 });
    expect(result).toMatchObject({ ok: true, status: "created", verified: false });
    if (result.ok) expect(result.warnings.join(" ")).toMatch(/Mirror Node did not show it yet/);
  });

  it("passes through name, symbol, decimals and memo, and warns about an adminKey", async () => {
    const { creator, requests } = fakeCreator();
    const result = await run(baseEnv(), fakeMirror({ tokens: { [NEW_TOKEN]: {} } }), {
      creator,
      name: "My Token",
      symbol: "MYT",
      decimals: 2,
      memo: "custom memo",
      withAdminKey: true,
    });
    expect(requests[0]).toMatchObject({
      name: "My Token",
      symbol: "MYT",
      decimals: 2,
      memo: "custom memo",
      withAdminKey: true,
    });
    expect(result).toMatchObject({ ok: true, adminKey: true });
    if (result.ok) expect(result.warnings.join(" ")).toMatch(/adminKey/);
  });

  it("never creates a second token when the configured one is usable", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror({ tokens: { [TOKEN]: {} } });
    const result = await run(baseEnv({ HEDERA_HTS_TOKEN_ID: TOKEN }), mirror, { creator });
    expect(result).toMatchObject({
      ok: true,
      status: "existing",
      tokenId: TOKEN,
      envLines: [`${HTS_ENV.TOKEN_ID}=${TOKEN}`],
    });
    expect(requests).toHaveLength(0);
  });

  it("does not create a token over a configured one that is unusable, and says how to proceed", async () => {
    const { creator, requests } = fakeCreator();
    const missing = await run(baseEnv({ HEDERA_HTS_TOKEN_ID: TOKEN }), fakeMirror(), { creator });
    expect(missing).toMatchObject({ ok: false, error: { code: "TOKEN_NOT_FOUND" } });
    const wrongTreasury = await run(
      baseEnv({ HEDERA_HTS_TOKEN_ID: TOKEN }),
      fakeMirror({ tokens: { [TOKEN]: { treasury: "0.0.9" } } }),
      { creator },
    );
    expect(wrongTreasury).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    if (!wrongTreasury.ok) expect(wrongTreasury.error.remediation).toMatch(/empty HEDERA_HTS_TOKEN_ID/);
    const wrongSupplyKey = await run(
      baseEnv({ HEDERA_HTS_TOKEN_ID: TOKEN }),
      fakeMirror({ tokens: { [TOKEN]: { supplyKey: "cd".repeat(32) } } }),
      { creator },
    );
    expect(wrongSupplyKey).toMatchObject({ ok: false, error: { code: "NO_MINT_PERMISSION" } });
    const malformed = await run(baseEnv({ HEDERA_HTS_TOKEN_ID: "nope" }), fakeMirror(), { creator });
    expect(malformed).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(requests).toHaveLength(0);
  });

  it("creates nothing when the Hedera environment (#5) is invalid, reporting why", async () => {
    const { creator, requests } = fakeCreator();
    const result = await run(baseEnv({ HEDERA_OPERATOR_ID: "" }), fakeMirror(), { creator });
    expect(result).toMatchObject({ ok: false, environment: { status: "invalid" }, error: { code: "CONFIG_INVALID" } });
    expect(requests).toHaveLength(0);
  });

  it("reports an unreachable network as retryable and creates nothing", async () => {
    const { creator, requests } = fakeCreator();
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    const result = await provisionHtsToken(baseEnv(), { fetch: down, inspectKey, creator });
    expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_UNAVAILABLE", retryable: true } });
    expect(requests).toHaveLength(0);
  });

  it("refuses mainnet unless allowed, before any request", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror();
    const refused = await run(baseEnv({ HEDERA_NETWORK: "mainnet" }), mirror, { creator });
    expect(refused).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
    expect(mirror.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("validates the memo, symbol, name length, decimals range and the network name", async () => {
    const { creator } = fakeCreator();
    expect(await run(baseEnv(), fakeMirror(), { creator, memo: "x".repeat(101) })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await run(baseEnv(), fakeMirror(), { creator, symbol: "x".repeat(33) })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await run(baseEnv(), fakeMirror(), { creator, name: "x".repeat(101) })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await run(baseEnv(), fakeMirror(), { creator, decimals: 19 })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await run(baseEnv(), fakeMirror(), { creator, decimals: -1 })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(await run(baseEnv({ HEDERA_NETWORK: "devnet" }), fakeMirror(), { creator })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
  });

  it("classifies creation failures and never retries", async () => {
    const attempts = { count: 0 };
    const failing: TokenCreator = {
      async create() {
        attempts.count++;
        throw hederaError("PrecheckStatusError", "INSUFFICIENT_PAYER_BALANCE");
      },
    };
    const result = await run(baseEnv(), fakeMirror(), { creator: failing });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TRANSACTION_FAILED", outcome: "rejected", hederaStatus: "INSUFFICIENT_PAYER_BALANCE" },
    });
    expect(attempts.count).toBe(1);
  });

  it("tells the user to check HashScan, not to retry, after a timeout (a second creation would leave a duplicate token)", async () => {
    const hanging: TokenCreator = {
      create: request => {
        request.onTransactionId(FIXED_TX_ID);
        return new Promise(() => undefined);
      },
    };
    const result = await run(baseEnv(), fakeMirror(), { creator: hanging, createTimeoutMs: 20 });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT", outcome: "unknown", retryable: false, transactionId: FIXED_TX_ID },
    });
    if (!result.ok) expect(result.error.remediation).toMatch(/duplicate/);
  });

  it("fails if the created token does not carry the operator as treasury and supply key", async () => {
    const { creator } = fakeCreator();
    const mirror = fakeMirror({ tokens: { [NEW_TOKEN]: { supplyKey: "cd".repeat(32) } } });
    expect(await run(baseEnv(), mirror, { creator })).toMatchObject({
      ok: false,
      error: { code: "NO_MINT_PERMISSION", transactionId: FIXED_TX_ID },
    });
  });

  it("never leaks the operator key", async () => {
    const { creator } = fakeCreator();
    const results = [
      await run(baseEnv(), fakeMirror({ tokens: { [NEW_TOKEN]: {} } }), { creator }),
      await run(baseEnv({ HEDERA_HTS_TOKEN_ID: "nope" }), fakeMirror(), { creator }),
      await run(baseEnv({ HEDERA_OPERATOR_ID: "" }), fakeMirror(), { creator }),
    ];
    expect(JSON.stringify(results)).not.toContain("efefef");
  });
});

describe("provisionHtsToken, pool-transfer (no supply key: needs an initial supply)", () => {
  it("creates the token with an initial supply and no supply key by default", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror({ tokens: { [NEW_TOKEN]: { supplyKey: null } } });
    const result = await run(baseEnv(), mirror, { creator, model: "pool-transfer" });
    expect(requests[0]).toMatchObject({ withSupplyKey: false, initialSupply: DEFAULT_POOL_INITIAL_SUPPLY });
    expect(result).toMatchObject({
      ok: true,
      supplyKey: false,
      envLines: [`${HTS_ENV.TOKEN_ID}=${NEW_TOKEN}`, "HEDERA_HTS_SETTLEMENT_MODEL=pool-transfer"],
    });
    if (result.ok) expect(result.warnings.join(" ")).toMatch(/no supply key/);
  });

  it("does not require a supply key when checking an existing configured pool token", async () => {
    const { creator, requests } = fakeCreator();
    const mirror = fakeMirror({ tokens: { [TOKEN]: { supplyKey: null } } });
    const result = await run(baseEnv({ HEDERA_HTS_TOKEN_ID: TOKEN }), mirror, { creator, model: "pool-transfer" });
    expect(result).toMatchObject({ ok: true, status: "existing" });
    expect(requests).toHaveLength(0);
  });

  it("refuses a pool token with neither a supply key nor an initial supply: it could never be used", async () => {
    const { creator } = fakeCreator();
    const result = await run(baseEnv(), fakeMirror(), {
      creator,
      model: "pool-transfer",
      withSupplyKey: false,
      initialSupply: 0n,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID" } });
  });

  it("an explicit --with-supply-key overrides the pool-transfer default", async () => {
    const { creator, requests } = fakeCreator();
    await run(baseEnv(), fakeMirror({ tokens: { [NEW_TOKEN]: {} } }), {
      creator,
      model: "pool-transfer",
      withSupplyKey: true,
    });
    expect(requests[0]).toMatchObject({ withSupplyKey: true, initialSupply: 0n });
  });
});

describe("confirmation and cost", () => {
  it("shows the plan and the estimated cost, then creates only after the answer is yes", async () => {
    const { creator, requests } = fakeCreator();
    const plans: unknown[] = [];
    const mirror = fakeMirror({ tokens: { [NEW_TOKEN]: {} }, rate: true, fee: 1_281_591_222 });
    const result = await run(baseEnv(), mirror, {
      creator,
      confirm: async (plan: unknown) => {
        plans.push(plan);
        expect(requests).toHaveLength(0); // nothing is paid for before the answer
        return true;
      },
    });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      network: "testnet",
      chainId: 296,
      operatorId: OPERATOR,
      balance: { hbar: "1000" },
      name: "Verifiable Settlement Credit",
      symbol: "HVS",
      model: "mint-transfer",
      withSupplyKey: true,
      cost: { free: true, usdPerHbar: "0.0771", createToken: { usd: "1", hbar: "12.9758" } },
    });
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, cost: { charged: { hbar: "12.81591222", usd: "0.988" } } });
  });

  it("creates nothing and reports CANCELLED when the answer is no", async () => {
    const { creator, requests } = fakeCreator();
    const result = await run(baseEnv(), fakeMirror({ tokens: { [NEW_TOKEN]: {} } }), {
      creator,
      confirm: async () => false,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "CANCELLED", outcome: "not_sent", retryable: false } });
    expect(requests).toHaveLength(0);
  });

  it("does not ask when nothing would be paid for (invalid environment, existing token, mainnet refusal)", async () => {
    const { creator } = fakeCreator();
    let asked = 0;
    const confirm = async () => (asked++, true);
    await run(baseEnv({ HEDERA_OPERATOR_ID: "" }), fakeMirror(), { creator, confirm });
    await run(baseEnv({ HEDERA_HTS_TOKEN_ID: TOKEN }), fakeMirror({ tokens: { [TOKEN]: {} } }), { creator, confirm });
    await run(baseEnv({ HEDERA_NETWORK: "mainnet" }), fakeMirror(), { creator, confirm });
    expect(asked).toBe(0);
  });

  it("still works, with USD only, when the exchange rate is unavailable", async () => {
    const { creator } = fakeCreator();
    let seen: { cost: { createToken: { hbar: string | null } } } | undefined;
    const result = await run(baseEnv(), fakeMirror({ tokens: { [NEW_TOKEN]: {} } }), {
      creator,
      confirm: async (plan: never) => ((seen = plan), true),
    });
    expect(seen?.cost.createToken.hbar).toBeNull();
    expect(result).toMatchObject({ ok: true, cost: { charged: null } });
  });
});

describe("createHieroTokenCreator", () => {
  function fakeSdk(receiptToken: string | null = "0.0.8888") {
    const state: Record<string, unknown> = {};
    class Fake implements TokenCreateTransactionLike {
      transactionId: { toString(): string } | null = null;
      setTokenName(n: string) {
        state.name = n;
        return this;
      }
      setTokenSymbol(s: string) {
        state.symbol = s;
        return this;
      }
      setTokenType(t: unknown) {
        state.type = t;
        return this;
      }
      setSupplyType(t: unknown) {
        state.supplyType = t;
        return this;
      }
      setDecimals(d: number) {
        state.decimals = d;
        return this;
      }
      setInitialSupply(a: bigint) {
        state.initialSupply = a;
        return this;
      }
      setTreasuryAccountId(a: string) {
        state.treasury = a;
        return this;
      }
      setSupplyKey(k: unknown) {
        state.supplyKey = k;
        return this;
      }
      setAdminKey(k: unknown) {
        state.adminKey = k;
        return this;
      }
      setTokenMemo(m: string) {
        state.memo = m;
        return this;
      }
      setRegenerateTransactionId(r: boolean) {
        state.regenerate = r;
        return this;
      }
      setMaxAttempts(n: number) {
        state.maxAttempts = n;
        return this;
      }
      setGrpcDeadline(ms: number) {
        state.deadline = ms;
        return this;
      }
      freezeWith() {
        this.transactionId = { toString: () => FIXED_TX_ID };
        return this;
      }
      async execute() {
        return {
          transactionId: { toString: () => FIXED_TX_ID },
          getReceipt: async () => ({ tokenId: receiptToken ? { toString: () => receiptToken } : null }),
        };
      }
    }
    return {
      sdk: {
        TokenCreateTransaction: Fake,
        TokenType: { FungibleCommon: "FUNGIBLE" },
        TokenSupplyType: { Infinite: "INFINITE" },
      } as HieroTokenSdkLike,
      state,
    };
  }
  const key = { publicKey: "PUBLIC" };
  const request = (withSupplyKey: boolean, withAdminKey = false, ids: string[] = []) => ({
    name: "N",
    symbol: "S",
    decimals: 0,
    initialSupply: 0n,
    withSupplyKey,
    withAdminKey,
    memo: "m",
    timeoutMs: 30_000,
    onTransactionId: (id: string) => ids.push(id),
  });

  it("sets treasury, type, supply type, and returns the token id; never regenerates the transaction id", async () => {
    const { sdk, state } = fakeSdk();
    const ids: string[] = [];
    const created = await createHieroTokenCreator({ client: {}, operatorId: OPERATOR, key, sdk }).create(
      request(false, false, ids),
    );
    expect(created).toEqual({ tokenId: "0.0.8888", transactionId: FIXED_TX_ID });
    expect(state).toMatchObject({
      treasury: OPERATOR,
      type: "FUNGIBLE",
      supplyType: "INFINITE",
      regenerate: false,
      maxAttempts: 3,
    });
    expect(state.supplyKey).toBeUndefined();
    expect(state.adminKey).toBeUndefined();
    expect(ids[0]).toBe(FIXED_TX_ID);
  });

  it("sets the supply key and the admin key only when asked", async () => {
    const { sdk, state } = fakeSdk();
    await createHieroTokenCreator({ client: {}, operatorId: OPERATOR, key, sdk }).create(request(true, true));
    expect(state.supplyKey).toBe("PUBLIC");
    expect(state.adminKey).toBe("PUBLIC");
  });

  it("fails when the receipt has no token id", async () => {
    const { sdk } = fakeSdk(null);
    await expect(
      createHieroTokenCreator({ client: {}, operatorId: OPERATOR, key, sdk }).create(request(false)),
    ).rejects.toThrow();
  });
});

describe("NETWORKS sanity", () => {
  it("testnet chain id is 296 (used by the plan assertion above)", () => {
    expect(NETWORKS.testnet.chainId).toBe(296);
  });
});

import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { createHtsAdapterFromEnv, preflightHtsAdapter } from "./factory";
import { HtsError } from "./errors";
import {
  contractKeyHex,
  makeInput,
  OPERATOR,
  OPERATOR_PUBLIC_KEY,
  ROUTER_ADDRESS,
  ROUTER_CONTRACT,
  TOKEN,
  world,
} from "./test-fixtures";

const iface = new Interface([
  "function statusOf(bytes32 eventKey) view returns (bool settled, bytes32 contentHash, uint64 settledAt)",
]);
const inspectKey = async () => [{ type: "ED25519" as const, publicKey: OPERATOR_PUBLIC_KEY }];
const routerEnv = (extra: Record<string, string> = {}) => ({
  HEDERA_NETWORK: "testnet",
  HEDERA_HTS_TOKEN_ID: TOKEN,
  HEDERA_SETTLEMENT_ROUTER_ADDRESS: ROUTER_ADDRESS,
  ...extra,
});
const operatorEnv = (extra: Record<string, string> = {}) =>
  routerEnv({
    HEDERA_HTS_CUSTODY: "operator",
    HEDERA_OPERATOR_ID: OPERATOR,
    HEDERA_OPERATOR_KEY: "ef".repeat(32),
    ...extra,
  });

/** One fetch for everything: the Mirror Node (account and token) and the JSON-RPC relay. */
function fakeNetwork(opts: { token?: object | null; settled?: boolean; balance?: bigint } = {}) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "POST") {
      return new Response(
        JSON.stringify({
          result: iface.encodeFunctionResult("statusOf", [opts.settled ?? false, `0x${"11".repeat(32)}`, 5]),
        }),
      );
    }
    if (url.pathname.startsWith("/api/v1/accounts/") && !url.pathname.endsWith("/tokens")) {
      return new Response(
        `{"account":"${OPERATOR}","deleted":false,"balance":{"balance":${opts.balance ?? 100000000000n},"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${OPERATOR_PUBLIC_KEY}"}}`,
      );
    }
    if (url.pathname.startsWith("/api/v1/tokens/")) {
      return opts.token === null
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify(opts.token ?? defaultToken));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}
const defaultToken = {
  token_id: TOKEN,
  type: "FUNGIBLE_COMMON",
  deleted: false,
  pause_status: "UNPAUSED",
  supply_type: "INFINITE",
  max_supply: "0",
  total_supply: "0",
  treasury_account_id: OPERATOR,
  decimals: "2",
  supply_key: { _type: "ED25519", key: OPERATOR_PUBLIC_KEY },
  symbol: "S",
};

describe("createHtsAdapterFromEnv", () => {
  it("fails with CONFIG_INVALID before creating anything when the configuration is unusable", async () => {
    const error = await createHtsAdapterFromEnv({}).catch(e => e);
    expect(error).toBeInstanceOf(HtsError);
    expect(error.code).toBe("CONFIG_INVALID");
  });

  it("router custody creates no executor and no Hedera client: it is preflight-only, as the ADR requires", async () => {
    const { adapter, close } = await createHtsAdapterFromEnv(routerEnv());
    expect(adapter.config).toMatchObject({ custody: "router", routerAddress: ROUTER_ADDRESS });
    expect((await adapter.settle(makeInput())).ok).toBe(false);
    close();
    close(); // safe twice
  });

  it("consults the router's statusOf when a router address is configured (the authority)", async () => {
    const net = fakeNetwork({ settled: true });
    const w = world();
    const { adapter } = await createHtsAdapterFromEnv(operatorEnv(), {
      fetch: net.impl,
      executor: w.executor,
      inspectKey,
    });
    // the router answers settled=true with a different contentHash, so the settlement is refused as a conflict
    const result = await adapter.settle(makeInput());
    expect(result).toMatchObject({ ok: false, failure: { code: "CONFLICTING_SETTLEMENT" } });
    expect(net.calls).toContain("POST /api");
  });

  it("uses an injected executor without creating a client", async () => {
    const w = world();
    const { adapter } = await createHtsAdapterFromEnv(operatorEnv({ HEDERA_SETTLEMENT_ROUTER_ADDRESS: "" }), {
      executor: w.executor,
    });
    void adapter;
  });

  it("reports an unusable operator as CONFIG_INVALID without echoing the key", async () => {
    const error = await createHtsAdapterFromEnv(operatorEnv({ HEDERA_OPERATOR_KEY: "not-a-key-SECRET" })).catch(e => e);
    expect(error).toBeInstanceOf(HtsError);
    expect(error.code).toBe("CONFIG_INVALID");
    expect(JSON.stringify(error.failure)).not.toContain("SECRET");
  });
});

describe("preflightHtsAdapter (the environment validator of #5, then the token and custody)", () => {
  it("passes when the environment, the configuration and the token are valid", async () => {
    const net = fakeNetwork();
    const result = await preflightHtsAdapter(operatorEnv(), { fetch: net.impl, inspectKey });
    expect(result).toMatchObject({ ok: true, setup: { ok: true } });
    expect(net.calls.some(c => c.includes("/accounts/"))).toBe(true);
    expect(net.calls.some(c => c.includes("/tokens/"))).toBe(true);
  });

  it("stops at an invalid configuration without any request", async () => {
    const net = fakeNetwork();
    expect(await preflightHtsAdapter({}, { fetch: net.impl, inspectKey })).toMatchObject({
      ok: false,
      error: { code: "CONFIG_INVALID" },
    });
    expect(net.calls).toHaveLength(0);
  });

  it("surfaces an invalid Hedera environment (#5) with its remediation", async () => {
    const result = await preflightHtsAdapter(operatorEnv({ HEDERA_OPERATOR_KEY: "" }), {
      fetch: fakeNetwork().impl,
      inspectKey,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID", retryable: false } });
    if (!result.ok) expect(result.error.message).toMatch(/MISSING_ENV/);
  });

  it("reports a token that does not exist as TOKEN_NOT_FOUND", async () => {
    expect(
      await preflightHtsAdapter(operatorEnv(), { fetch: fakeNetwork({ token: null }).impl, inspectKey }),
    ).toMatchObject({ ok: false, error: { code: "TOKEN_NOT_FOUND" } });
  });

  it("checks router custody through the contract's supply key (ADR v1)", async () => {
    const routerToken = {
      ...defaultToken,
      treasury_account_id: ROUTER_CONTRACT,
      supply_key: { _type: "ProtobufEncoded", key: contractKeyHex(7000) },
    };
    const impl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/v1/contracts/"))
        return new Response(JSON.stringify({ contract_id: ROUTER_CONTRACT }));
      if (url.pathname.startsWith("/api/v1/tokens/")) return new Response(JSON.stringify(routerToken));
      return new Response(
        `{"account":"${OPERATOR}","deleted":false,"balance":{"balance":100000000000,"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${OPERATOR_PUBLIC_KEY}"}}`,
      );
    }) as typeof fetch;
    const result = await preflightHtsAdapter(
      routerEnv({ HEDERA_OPERATOR_ID: OPERATOR, HEDERA_OPERATOR_KEY: "ef".repeat(32) }),
      { fetch: impl, inspectKey },
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("does not leak the operator key", async () => {
    const result = await preflightHtsAdapter(operatorEnv({ HEDERA_HTS_TOKEN_ID: "bad" }), {
      fetch: fakeNetwork().impl,
      inspectKey,
    });
    expect(JSON.stringify(result)).not.toContain("efefef");
  });
});

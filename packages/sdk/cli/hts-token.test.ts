import { describe, expect, it } from "vitest";
import { formatTokenPlan, runCreateToken } from "./hts-token";
import { EXIT } from "./setup";
import type { TokenCreator } from "../hedera/hts/token-create";
import { buildHtsCostEstimate } from "../hedera/hts/cost";
import { NETWORKS } from "../hedera/networks";

const PUBLIC_KEY = "ab".repeat(32);
const env = { HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: "0.0.1234", HEDERA_OPERATOR_KEY: "ef".repeat(32) };
const inspectKey = async () => [{ type: "ED25519" as const, publicKey: PUBLIC_KEY }];
const TX = "0.0.1234@1767225600.123456789";

/** Mirror Node: the account, the token, the exchange rate and the charged fee. */
function fakeMirror(overrides: { treasury?: string; supplyKey?: string | null } = {}) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/v1/accounts/")) {
      return new Response(
        `{"account":"0.0.1234","deleted":false,"balance":{"balance":100000000000,"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${PUBLIC_KEY}"}}`,
      );
    }
    if (url.pathname === "/api/v1/network/exchangerate") {
      return new Response(JSON.stringify({ current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } }));
    }
    if (url.pathname.startsWith("/api/v1/transactions/")) {
      return new Response(JSON.stringify({ transactions: [{ charged_tx_fee: 1_281_591_222 }] }));
    }
    const supplyKey = overrides.supplyKey === undefined ? PUBLIC_KEY : overrides.supplyKey;
    return new Response(
      JSON.stringify({
        token_id: "0.0.8888",
        type: "FUNGIBLE_COMMON",
        deleted: false,
        pause_status: "UNPAUSED",
        supply_type: "INFINITE",
        max_supply: "0",
        total_supply: "0",
        treasury_account_id: overrides.treasury ?? "0.0.1234",
        decimals: "0",
        supply_key: supplyKey ? { _type: "ED25519", key: supplyKey } : null,
        symbol: "HVS",
      }),
    );
  }) as typeof fetch;
}

const created: unknown[] = [];
const creator: TokenCreator = {
  create: async request => (created.push(request), { tokenId: "0.0.8888", transactionId: TX }),
};
const baseOptions = { fetch: fakeMirror(), inspectKey, creator, sleep: async () => undefined };
const text = (r: { lines: string[] }) => r.lines.join("\n");

describe("runCreateToken", () => {
  it("shows the plan and cost, asks, then creates only after the answer is yes", async () => {
    created.length = 0;
    let shown = "";
    const result = await runCreateToken([], env, {
      ...baseOptions,
      confirm: async lines => {
        expect(created).toHaveLength(0); // nothing is paid for before the answer
        shown = lines.join("\n");
        return true;
      },
    });
    expect(shown).toContain("What will be created");
    expect(shown).toContain("Treasury: the operator account");
    expect(shown).toContain("Supply key: the operator");
    expect(shown).toContain("No admin key");
    expect(shown).toContain("Create the token      about $1 (~12.9758 HBAR at $0.0771/HBAR)");
    expect(shown).toContain("Testnet HBAR has no monetary value");
    expect(result.exitCode).toBe(EXIT.OK);
    expect(created).toHaveLength(1);
    expect(text(result)).toContain("charged 12.81591222 HBAR (about $0.988)");
  });

  it("creates nothing when the answer is no", async () => {
    created.length = 0;
    const result = await runCreateToken([], env, { ...baseOptions, confirm: async () => false });
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("Cancelled. Nothing was created and nothing was charged.");
    expect(created).toHaveLength(0);
  });

  it("refuses to create without a terminal and without --yes, but still shows the cost", async () => {
    created.length = 0;
    const result = await runCreateToken([], env, baseOptions);
    expect(result.exitCode).toBe(EXIT.INVALID);
    const out = text(result);
    expect(out).toContain("Not running in an interactive terminal");
    expect(out).toContain("pass --yes");
    expect(out).toContain("Estimated cost");
    expect(created).toHaveLength(0);
  });

  it("with --yes does not ask, and puts the plan in the output", async () => {
    created.length = 0;
    const result = await runCreateToken(["--yes"], env, baseOptions);
    const out = text(result);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(out).toContain("What will be created");
    expect(out).toContain("Created token 0.0.8888 on testnet");
    expect(created).toHaveLength(1);
  });

  it("lists id, treasury, supply key, admin key, cost, HashScan and the .env line", async () => {
    const out = text(await runCreateToken(["-y"], env, baseOptions));
    for (const expected of [
      "Token ID      0.0.8888",
      `Transaction   ${TX}`,
      "Treasury      the operator account",
      "Supply key    the operator (can mint)",
      "Admin key     none: permanent",
      "Cost          charged 12.81591222 HBAR",
      "HashScan      https://hashscan.io/testnet/token/0.0.8888",
      "Set in .env: HEDERA_HTS_TOKEN_ID=0.0.8888",
      "yarn hts:settle preflight",
    ]) {
      expect(out).toContain(expected);
    }
  });

  it("says nothing was created or charged when a usable token is already configured, and does not ask", async () => {
    created.length = 0;
    let asked = 0;
    const result = await runCreateToken(
      [],
      { ...env, HEDERA_HTS_TOKEN_ID: "0.0.8888" },
      { ...baseOptions, confirm: async () => (asked++, true) },
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(text(result)).toContain("nothing was created and nothing was charged");
    expect(asked).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("passes --name, --symbol, --decimals, --model, --initial-supply, --with-admin-key through", async () => {
    created.length = 0;
    const seen: unknown[] = [];
    const spy: TokenCreator = {
      create: async request => (seen.push(request), { tokenId: "0.0.8888", transactionId: TX }),
    };
    await runCreateToken(
      [
        "--yes",
        "--name",
        "My Token",
        "--symbol",
        "MYT",
        "--decimals",
        "2",
        "--model",
        "pool-transfer",
        "--initial-supply",
        "500",
        "--with-admin-key",
      ],
      env,
      { ...baseOptions, creator: spy, fetch: fakeMirror({ supplyKey: null }) },
    );
    expect(seen[0]).toMatchObject({
      name: "My Token",
      symbol: "MYT",
      decimals: 2,
      initialSupply: 500n,
      withSupplyKey: false,
      withAdminKey: true,
    });
  });

  it("--no-supply-key without an initial supply is refused, without sending anything", async () => {
    created.length = 0;
    const result = await runCreateToken(["--yes", "--no-supply-key"], env, baseOptions);
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("CONFIG_INVALID");
    expect(created).toHaveLength(0);
  });

  it("never prints the operator key", async () => {
    expect(text(await runCreateToken(["--yes"], env, baseOptions))).not.toContain("efefef");
  });

  it("exits 1 with the same environment report as `yarn setup` when the environment is invalid", async () => {
    const result = await runCreateToken(["--yes"], {}, baseOptions);
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("[MISSING_ENV] HEDERA_OPERATOR_ID");
  });

  it("exits 2 when the network cannot be reached", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    expect((await runCreateToken(["--yes"], env, { ...baseOptions, fetch: down })).exitCode).toBe(EXIT.UNVERIFIED);
  });

  it("refuses mainnet without --allow-mainnet", async () => {
    const result = await runCreateToken(["--yes"], { ...env, HEDERA_NETWORK: "mainnet" }, baseOptions);
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("--allow-mainnet");
  });

  it("prints machine-readable JSON and keeps the exit codes", async () => {
    const result = await runCreateToken(["--yes", "--json"], env, baseOptions);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.lines[0])).toMatchObject({
      ok: true,
      tokenId: "0.0.8888",
      envLines: ["HEDERA_HTS_TOKEN_ID=0.0.8888", "HEDERA_HTS_CUSTODY=operator"],
    });
  });
});

describe("formatTokenPlan", () => {
  const plan = (network: keyof typeof NETWORKS, extra = {}) => ({
    network,
    chainId: NETWORKS[network].chainId,
    operatorId: "0.0.1234",
    balance: { tinybars: "1", hbar: "1000" },
    name: "Verifiable Settlement Credit",
    symbol: "HVS",
    decimals: 0,
    initialSupply: "0",
    model: "mint-transfer" as const,
    withSupplyKey: true,
    withAdminKey: false,
    cost: buildHtsCostEstimate(NETWORKS[network], null),
    ...extra,
  });

  it("warns that mainnet is real money and permanent", () => {
    const out = formatTokenPlan(plan("mainnet")).join("\n");
    expect(out).toContain("This is MAINNET: these are real charges and the token is permanent.");
    expect(out).not.toContain("no monetary value");
  });

  it("explains a token with no supply key", () => {
    const out = formatTokenPlan(plan("testnet", { withSupplyKey: false, model: "pool-transfer" })).join("\n");
    expect(out).toContain("No supply key: this token can never be minted");
  });

  it("shows USD only when the rate is unknown", () => {
    const out = formatTokenPlan(plan("testnet")).join("\n");
    expect(out).toContain("Create the token      about $1\n");
    expect(out).not.toContain("Exchange rate");
  });
});

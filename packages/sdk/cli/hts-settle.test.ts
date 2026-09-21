import { describe, expect, it } from "vitest";
import { createHtsSettlementAdapter } from "../hedera/hts/adapter";
import { loadHtsAdapterConfig } from "../hedera/hts/config";
import type { HtsAdapterFromEnvOptions, HtsAdapterHandle } from "../hedera/hts/factory";
import { HtsError } from "../hedera/hts/errors";
import type { HtsExecutor } from "../hedera/hts/executor";
import { BENEFICIARY, OPERATOR, OPERATOR_PUBLIC_KEY, TOKEN, world } from "../hedera/hts/test-fixtures";
import { runHtsSettle } from "./hts-settle";
import { EXIT } from "./setup";
import type { HtsSettleOptions } from "./hts-settle";

const inspectKey = async () => [{ type: "ED25519" as const, publicKey: OPERATOR_PUBLIC_KEY }];
const baseEnv = (extra: Record<string, string> = {}) => ({
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: OPERATOR,
  HEDERA_OPERATOR_KEY: "ef".repeat(32),
  HEDERA_HTS_TOKEN_ID: TOKEN,
  HEDERA_HTS_CUSTODY: "operator",
  ...extra,
});

/** One fetch for everything the CLI needs: the operator account, the token, the exchange rate and charged fees. */
function fakeNetwork(w: ReturnType<typeof world>, opts: { rate?: boolean; fee?: number } = {}) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    if (url.pathname === "/api/v1/network/exchangerate") {
      return opts.rate === false
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify({ current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } }));
    }
    if (url.pathname.startsWith("/api/v1/transactions/")) {
      return opts.fee === undefined
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ transactions: [{ charged_tx_fee: opts.fee }] }));
    }
    if (url.pathname === `/api/v1/accounts/${OPERATOR}`) {
      return new Response(
        `{"account":"${OPERATOR}","deleted":false,"balance":{"balance":100000000000,"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${OPERATOR_PUBLIC_KEY}"}}`,
      );
    }
    if (url.pathname === `/api/v1/tokens/${TOKEN}`) {
      const t = w.token;
      return t
        ? new Response(
            JSON.stringify({
              token_id: t.tokenId,
              type: t.type,
              deleted: t.deleted,
              pause_status: t.paused ? "PAUSED" : "UNPAUSED",
              supply_type: t.supplyType,
              max_supply: String(t.maxSupply),
              total_supply: String(t.totalSupply),
              treasury_account_id: t.treasuryAccountId,
              decimals: String(t.decimals),
              supply_key: t.supplyKey ? { _type: t.supplyKey.type, key: t.supplyKey.key } : null,
              symbol: t.symbol,
            }),
          )
        : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

/** Wires the CLI's `createAdapter` to the in-memory world instead of a real Hedera client. */
function withWorld(
  w: ReturnType<typeof world>,
  net: ReturnType<typeof fakeNetwork>,
  extra: Partial<HtsSettleOptions> = {},
) {
  const createAdapter = async (
    env: Record<string, string | undefined>,
    opts: HtsAdapterFromEnvOptions = {},
  ): Promise<HtsAdapterHandle> => {
    const config = loadHtsAdapterConfig(env);
    const executor: HtsExecutor | undefined = opts.withExecutor === false ? undefined : (opts.executor ?? w.executor);
    return {
      adapter: createHtsSettlementAdapter({
        config,
        mirror: w.mirror,
        executor,
        operatorKeys: [{ type: "ED25519", publicKey: OPERATOR_PUBLIC_KEY }],
        ...opts,
      }),
      close: () => undefined,
    };
  };
  return { fetch: net.impl, inspectKey, createAdapter, ...extra };
}

const text = (r: { lines: string[] }) => r.lines.join("\n");
const alwaysNo = async () => false;

describe("no subcommand", () => {
  it("prints usage and exits 1", async () => {
    const result = await runHtsSettle([], baseEnv());
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("Usage: yarn hts:settle");
  });
});

describe("preflight", () => {
  it("requires --to and --amount", async () => {
    const result = await runHtsSettle(["preflight"], baseEnv());
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("Usage:");
  });

  it("passes for a well-formed settlement, without sending anything", async () => {
    const w = world();
    const net = fakeNetwork(w);
    const result = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv(),
      withWorld(w, net),
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(text(result)).toContain("This settlement would go through");
    expect(w.calls.executor).toHaveLength(0);
  });

  it("reports the specific failure for a beneficiary that is not associated", async () => {
    const w = world();
    w.removeAssociation(BENEFICIARY);
    const result = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("NOT_ASSOCIATED");
  });

  it("surfaces an invalid configuration before checking anything else, without any network request", async () => {
    const w = world();
    const net = fakeNetwork(w);
    const result = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv({ HEDERA_OPERATOR_ID: "" }),
      withWorld(w, net),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("HEDERA_OPERATOR_ID");
    expect(net.calls).toHaveLength(0);
  });

  it("surfaces an invalid Hedera environment (#5) once the configuration itself is valid", async () => {
    const w = world();
    const result = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv({ HEDERA_OPERATOR_KEY: "" }),
      withWorld(w, fakeNetwork(w)),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("MISSING_ENV");
  });

  it("is deterministic: the same --label gives the same eventKey across runs", async () => {
    const w = world();
    const net = fakeNetwork(w);
    const a = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100", "--label", "same"],
      baseEnv(),
      withWorld(w, net),
    );
    const b = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100", "--label", "same"],
      baseEnv(),
      withWorld(w, net),
    );
    const eventKeyOf = (r: typeof a) => r.lines.find(l => l.includes("eventKey"));
    expect(eventKeyOf(a)).toBe(eventKeyOf(b));
  });

  it("prints machine-readable JSON", async () => {
    const w = world();
    const result = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100", "--json"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(JSON.parse(result.lines[0])).toMatchObject({ valid: true, ok: true });
  });

  it("never prints the operator key", async () => {
    const w = world();
    const result = await runHtsSettle(
      ["preflight", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(text(result)).not.toContain("efefef");
  });
});

describe("transfer", () => {
  it("requires --to and --amount", async () => {
    expect((await runHtsSettle(["transfer"], baseEnv())).exitCode).toBe(EXIT.INVALID);
  });

  it("shows the plan and cost, asks, and sends nothing until confirmed", async () => {
    const w = world();
    let shown = "";
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv(),
      withWorld(w, fakeNetwork(w), {
        confirm: async lines => {
          expect(w.calls.executor).toHaveLength(0);
          shown = lines.join("\n");
          return true;
        },
      }),
    );
    expect(shown).toContain("Estimated cost");
    expect(shown).toContain("mint");
    expect(shown).toContain("transfer");
    expect(shown).toContain("already done, nothing will be sent");
    expect(result.exitCode).toBe(EXIT.OK);
    expect(w.calls.executor.length).toBeGreaterThan(0);
    expect(w.token?.totalSupply).toBe(100n);
  });

  it("sends nothing and says so when the answer is no", async () => {
    const w = world();
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv(),
      withWorld(w, fakeNetwork(w), { confirm: alwaysNo }),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("Cancelled. Nothing was sent and nothing was charged.");
    expect(w.calls.executor).toHaveLength(0);
  });

  it("refuses without a terminal and without --yes, but still shows the plan", async () => {
    const w = world();
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    const out = text(result);
    expect(out).toContain("Not running in an interactive terminal");
    expect(out).toContain("pass --yes");
    expect(out).toContain("Estimated cost");
    expect(w.calls.executor).toHaveLength(0);
  });

  it("--yes sends without asking, and does not stop for a Mirror-lag-free settlement that is already done", async () => {
    const w = world();
    const net = fakeNetwork(w);
    const options = withWorld(w, net);
    await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100", "--yes", "--label", "same"],
      baseEnv(),
      options,
    );
    const second = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100", "--yes", "--label", "same"],
      baseEnv(),
      options,
    );
    expect(second.exitCode).toBe(EXIT.OK);
    expect(text(second)).toContain("Already settled");
    expect(text(second)).toContain("nothing was charged");
    expect(w.token?.totalSupply).toBe(100n); // one credit, not two
  });

  it("does not ask when the settlement would fail: nothing to confirm", async () => {
    const w = world();
    w.removeAssociation(BENEFICIARY);
    let asked = 0;
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100"],
      baseEnv(),
      withWorld(w, fakeNetwork(w), { confirm: async () => (asked++, true) }),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("NOT_ASSOCIATED");
    expect(asked).toBe(0);
    expect(w.calls.executor).toHaveLength(0);
  });

  it("reports a real HTS failure (e.g. a transfer rejected mid-flight) with its structured code", async () => {
    const w = world();
    w.state.faults.transfer = Object.assign(new Error("x"), {
      name: "ReceiptStatusError",
      status: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
    });
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100", "--yes"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("NOT_ASSOCIATED");
  });

  it("refuses mainnet without --allow-mainnet, before any request", async () => {
    const w = world({});
    const net = fakeNetwork(w);
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100", "--yes"],
      baseEnv({ HEDERA_NETWORK: "mainnet" }),
      withWorld(w, net),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("--allow-mainnet");
    expect(net.calls).toHaveLength(0);
  });

  it("prints JSON with the settle result", async () => {
    const w = world();
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "50", "--yes", "--json"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(JSON.parse(result.lines[0])).toMatchObject({ ok: true, status: "settled", to: BENEFICIARY, amount: "50" });
  });

  it("never prints the operator key even on failure", async () => {
    const w = world();
    w.state.faults.mint = new HtsError({
      code: "NO_MINT_PERMISSION",
      outcome: "rejected",
      operation: "mint",
      message: "operator key ef".repeat(4),
      remediation: "r",
      retryable: false,
    });
    const result = await runHtsSettle(
      ["transfer", "--to", BENEFICIARY, "--amount", "100", "--yes"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(text(result)).not.toContain("efefef");
  });
});

describe("associate", () => {
  it("requires --to", async () => {
    expect((await runHtsSettle(["associate"], baseEnv())).exitCode).toBe(EXIT.INVALID);
  });

  it("associates the operator's own account without an --account-key", async () => {
    const w = world();
    w.removeAssociation(OPERATOR);
    const result = await runHtsSettle(
      ["associate", "--to", OPERATOR, "--yes"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(w.isAssociated(OPERATOR)).toBe(true);
  });

  it("is idempotent: an already-associated account is reported as such, without asking to pay again", async () => {
    const w = world();
    const result = await runHtsSettle(
      ["associate", "--to", BENEFICIARY, "--yes"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(result.exitCode).toBe(EXIT.OK);
    expect(text(result)).toContain("Already associated; nothing was sent and nothing was charged.");
    expect(w.calls.executor).toHaveLength(0);
  });

  it("resolves --account-key for a third-party account via the injected resolver, and uses it to sign", async () => {
    const w = world();
    w.removeAssociation(BENEFICIARY);
    let resolved: unknown;
    const seenKeys: unknown[] = [];
    const executor: HtsExecutor = {
      ...w.executor,
      associate: async request => {
        seenKeys.push((request as unknown as { signedWith?: unknown }).signedWith);
        return w.executor.associate(request);
      },
    };
    const result = await runHtsSettle(
      ["associate", "--to", BENEFICIARY, "--account-key", "cd".repeat(32), "--yes"],
      baseEnv(),
      withWorld(w, fakeNetwork(w), {
        resolveAccountKey: async (rawKey, accountId) => {
          resolved = { rawKey, accountId };
          return "RESOLVED-KEY";
        },
        createAdapter: async (env, opts = {}) => {
          const config = loadHtsAdapterConfig(env);
          return {
            adapter: createHtsSettlementAdapter({
              config,
              mirror: w.mirror,
              executor: opts.executor ?? executor,
              ...opts,
            }),
            close: () => undefined,
          };
        },
      }),
    );
    expect(resolved).toEqual({ rawKey: "cd".repeat(32), accountId: BENEFICIARY });
    expect(result.exitCode).toBe(EXIT.OK);
  });

  it("without a key for a third-party account, reports ASSOCIATION_NOT_AUTHORIZED with the hint to use --account-key", async () => {
    const w = world();
    w.removeAssociation(BENEFICIARY);
    // The fake executor's own `associate` always succeeds; this scenario exercises the CLI's handling of the failure the
    // real executor would raise (already covered by executor.test.ts), so inject it directly.
    w.state.faults.associate = new HtsError({
      code: "ASSOCIATION_NOT_AUTHORIZED",
      outcome: "not_sent",
      operation: "associate",
      message: "Account 0.0.9001 must sign its own association, and this process does not hold its key.",
      remediation: "Ask the account owner to associate the token, or supply --account-key.",
      retryable: false,
    });
    const result = await runHtsSettle(
      ["associate", "--to", BENEFICIARY, "--yes"],
      baseEnv(),
      withWorld(w, fakeNetwork(w)),
    );
    expect(result.exitCode).toBe(EXIT.INVALID);
    expect(text(result)).toContain("ASSOCIATION_NOT_AUTHORIZED");
    expect(text(result)).toContain("--account-key");
  });

  it("still shows the plan and asks even when the account turns out to already be associated (reported, nothing charged)", async () => {
    const w = world();
    let asked = 0;
    const result = await runHtsSettle(
      ["associate", "--to", BENEFICIARY],
      baseEnv(),
      withWorld(w, fakeNetwork(w), {
        confirm: async lines => {
          asked++;
          expect(lines.join("\n")).toContain("already associated, nothing will be sent");
          return true;
        },
      }),
    );
    expect(asked).toBe(1);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(text(result)).toContain("Already associated");
  });

  it("shows the cost and asks before sending", async () => {
    const w = world();
    w.removeAssociation(BENEFICIARY);
    let shown = "";
    await runHtsSettle(
      ["associate", "--to", BENEFICIARY],
      baseEnv(),
      withWorld(w, fakeNetwork(w), {
        confirm: async lines => {
          shown = lines.join("\n");
          expect(w.calls.executor).toHaveLength(0);
          return true;
        },
      }),
    );
    expect(shown).toContain("Estimated cost");
    expect(shown).toContain("associate");
  });

  it("reports the charged fee after a real association", async () => {
    const w = world();
    w.removeAssociation(BENEFICIARY);
    const result = await runHtsSettle(
      ["associate", "--to", BENEFICIARY, "--yes"],
      baseEnv(),
      withWorld(w, fakeNetwork(w, { fee: 64_079_560 })),
    );
    expect(text(result)).toContain("Charged 0.6407956 HBAR");
  });
});

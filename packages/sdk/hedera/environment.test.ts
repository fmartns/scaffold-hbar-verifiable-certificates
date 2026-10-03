import { PrivateKey } from "@hashgraph/sdk";
import { describe, expect, it } from "vitest";
import { formatEnvironmentReport } from "./environment-report";
import {
  ENV,
  formatHbar,
  inspectPrivateKey,
  isUnverified,
  parseHbar,
  redactUrl,
  validateHederaEnvironment,
} from "./environment";
import type { EnvironmentValidation, KeyInspector } from "./environment";
import { NETWORKS } from "./networks";

const ACCOUNT = "0.0.1234";
const PUBLIC_KEY = "ab".repeat(32);
const SECRET_KEY = "cd".repeat(32);
const HBAR = 100_000_000n;

const hostOf = (url: string) => new URL(url).host;
const TESTNET_MIRROR = hostOf(NETWORKS.testnet.mirrorNodeUrl);
const MAINNET_MIRROR = hostOf(NETWORKS.mainnet.mirrorNodeUrl);

type AccountFixture = { balance: bigint; key?: { type: string; key: string } | null; deleted?: boolean };

/** Serializes like the Mirror Node does; the balance is written verbatim so values above 2^53 stay exact. */
function accountJson(
  id: string,
  { balance, key = { type: "ED25519", key: PUBLIC_KEY }, deleted = false }: AccountFixture,
) {
  const keyJson = key ? `{"_type":"${key.type}","key":"${key.key}"}` : "null";
  return `{"account":"${id}","deleted":${deleted},"balance":{"balance":${balance},"timestamp":"1.0","tokens":[]},"key":${keyJson}}`;
}

type Network = "testnet" | "mainnet";

/** In-memory Mirror Node and relay. Unknown accounts answer 404, like the real service. */
function fakeNetwork(
  accounts: Partial<Record<Network, Record<string, AccountFixture>>> = {},
  overrides: { down?: Network[]; status?: number; relayChainId?: number | "down" } = {},
) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    const network: Network | undefined =
      url.host === TESTNET_MIRROR ? "testnet" : url.host === MAINNET_MIRROR ? "mainnet" : undefined;
    if (init?.method === "POST") {
      if (overrides.relayChainId === "down" || overrides.relayChainId === undefined)
        throw new Error("connect ECONNREFUSED");
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${overrides.relayChainId.toString(16)}` }),
      );
    }
    if (network && overrides.down?.includes(network)) throw new Error("connect ECONNREFUSED");
    if (network && overrides.status) return new Response("upstream error", { status: overrides.status });
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const fixture = network ? accounts[network]?.[id] : undefined;
    return fixture
      ? new Response(accountJson(id, fixture))
      : new Response('{"_status":{"messages":[{"message":"Not found"}]}}', { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const inspectMatching: KeyInspector = async () => [{ type: "ED25519", publicKey: PUBLIC_KEY }];
const validEnv = { HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: ACCOUNT, HEDERA_OPERATOR_KEY: SECRET_KEY };
const now = () => new Date("2026-09-18T12:00:00.000Z");

const codes = (r: EnvironmentValidation) => (r.ok ? [] : r.issues.map(i => i.code));
const failure = (r: EnvironmentValidation) => {
  if (r.ok) throw new Error("expected a failure");
  return r;
};

describe("scenario 1 — required variable missing", () => {
  it("reports every missing variable at once, by name, without touching the network", async () => {
    const net = fakeNetwork();
    const result = failure(await validateHederaEnvironment({}, { fetch: net.fetch, inspectKey: inspectMatching, now }));

    expect(result.status).toBe("invalid");
    expect(codes(result)).toEqual(["MISSING_ENV", "MISSING_ENV"]);
    expect(result.issues.map(i => i.variable)).toEqual([ENV.OPERATOR_ID, ENV.OPERATOR_KEY]);
    expect(result.issues.every(i => i.category === "missing_env")).toBe(true);
    expect(result.issues[0].remediation).toMatch(/cp \.env\.example \.env/);
    expect(net.calls).toEqual([]);
  });

  it("treats a blank value like an unset one", async () => {
    const result = failure(
      await validateHederaEnvironment(
        { ...validEnv, HEDERA_OPERATOR_ID: "   " },
        { fetch: fakeNetwork().fetch, inspectKey: inspectMatching },
      ),
    );
    expect(codes(result)).toEqual(["MISSING_ENV"]);
    expect(result.issues[0].variable).toBe(ENV.OPERATOR_ID);
  });

  it("does not require the private key when the consumer is read-only", async () => {
    const env = { HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: ACCOUNT };
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } });
    const result = await validateHederaEnvironment(env, { fetch: net.fetch, requireOperatorKey: false, now });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keyVerified).toBe(false);
  });
});

describe("scenario 2 — invalid or nonexistent account", () => {
  it("rejects a malformed account ID without touching the network", async () => {
    const net = fakeNetwork();
    const result = failure(
      await validateHederaEnvironment(
        { ...validEnv, HEDERA_OPERATOR_ID: "abc" },
        { fetch: net.fetch, inspectKey: inspectMatching },
      ),
    );
    expect(codes(result)).toEqual(["INVALID_ACCOUNT_ID"]);
    expect(result.issues[0].category).toBe("account");
    expect(net.calls).toEqual([]);
  });

  it("explains an EVM address, a pasted private key and a checksum suffix differently", async () => {
    const run = async (value: string) =>
      failure(
        await validateHederaEnvironment(
          { ...validEnv, HEDERA_OPERATOR_ID: value },
          { fetch: fakeNetwork().fetch, inspectKey: inspectMatching },
        ),
      );

    expect((await run(`0x${"1".repeat(40)}`)).issues[0].remediation).toMatch(/EVM address/);
    expect((await run(SECRET_KEY)).issues[0].remediation).toMatch(/HEDERA_OPERATOR_KEY/);
    expect((await run("0.0.1234-vfmkw")).issues[0].remediation).toMatch(/checksum/);
  });

  it("distinguishes a well-formed account that does not exist", async () => {
    const net = fakeNetwork();
    const result = failure(
      await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching, now }),
    );
    expect(codes(result)).toEqual(["ACCOUNT_NOT_FOUND"]);
    expect(result.issues[0].message).toContain(ACCOUNT);
    expect(result.issues[0].remediation).toMatch(/reset/i);
    expect(result.status).toBe("invalid");
  });

  it("rejects a deleted account", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR, deleted: true } } });
    expect(codes(await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching }))).toEqual(
      ["ACCOUNT_DELETED"],
    );
  });

  it("rejects a private key that is not a key, and one that belongs to another account", async () => {
    const notAKey: KeyInspector = async () => null;
    expect(
      codes(await validateHederaEnvironment(validEnv, { fetch: fakeNetwork().fetch, inspectKey: notAKey })),
    ).toEqual(["INVALID_OPERATOR_KEY"]);

    const wrongKey: KeyInspector = async () => [{ type: "ED25519", publicKey: "ef".repeat(32) }];
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } });
    const result = failure(await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: wrongKey }));
    expect(codes(result)).toEqual(["KEY_MISMATCH"]);
    expect(result.issues[0].category).toBe("key");
  });
});

describe("scenario 3 — insufficient balance", () => {
  it("reports the balance found and the minimum, with the faucet on testnet", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 3n * HBAR + 50_000_000n } } });
    const result = failure(
      await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching, now }),
    );

    expect(codes(result)).toEqual(["INSUFFICIENT_BALANCE"]);
    const [item] = result.issues;
    expect(item.category).toBe("balance");
    expect(item.message).toContain("3.5 HBAR");
    expect(item.message).toContain("at least 20 HBAR");
    expect(item.remediation).toContain("https://portal.hedera.com/faucet");
    expect(item.details).toEqual({ balanceTinybars: "350000000", minimumTinybars: "2000000000" });
  });

  it("honors a custom minimum, and the balance exactly at the minimum is enough", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 5n * HBAR } } });
    const env = { ...validEnv, HEDERA_MIN_BALANCE_HBAR: "5" };
    expect((await validateHederaEnvironment(env, { fetch: net.fetch, inspectKey: inspectMatching })).ok).toBe(true);
    expect(
      codes(
        await validateHederaEnvironment(
          { ...env, HEDERA_MIN_BALANCE_HBAR: "5.00000001" },
          { fetch: net.fetch, inspectKey: inspectMatching },
        ),
      ),
    ).toEqual(["INSUFFICIENT_BALANCE"]);
  });

  it("rejects a nonsensical minimum instead of ignoring it", async () => {
    const result = failure(
      await validateHederaEnvironment(
        { ...validEnv, HEDERA_MIN_BALANCE_HBAR: "lots" },
        { fetch: fakeNetwork().fetch, inspectKey: inspectMatching },
      ),
    );
    expect(codes(result)).toEqual(["INVALID_MIN_BALANCE"]);
  });

  it("keeps balances above 2^53 exact", async () => {
    const treasury = 3_388_410_702_715_765_302n;
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: treasury } } });
    const result = await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching });
    expect(result.ok && result.balance.tinybars).toBe(treasury.toString());
  });
});

describe("scenario 4 — wrong network", () => {
  it("rejects an unsupported HEDERA_NETWORK", async () => {
    const net = fakeNetwork();
    const result = failure(
      await validateHederaEnvironment(
        { ...validEnv, HEDERA_NETWORK: "previewnet" },
        { fetch: net.fetch, inspectKey: inspectMatching },
      ),
    );
    expect(codes(result)).toEqual(["INVALID_NETWORK"]);
    expect(result.issues[0].category).toBe("network");
    expect(result.issues[0].remediation).toContain("testnet, mainnet, local");
    expect(net.calls).toEqual([]);
  });

  it("detects an account that exists on the other network", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } });
    const result = failure(
      await validateHederaEnvironment(
        { ...validEnv, HEDERA_NETWORK: "mainnet" },
        { fetch: net.fetch, inspectKey: inspectMatching },
      ),
    );

    expect(codes(result)).toEqual(["NETWORK_MISMATCH"]);
    expect(result.issues[0].details).toMatchObject({ configuredNetwork: "mainnet", foundOn: "testnet" });
    expect(result.issues[0].remediation).toContain("HEDERA_NETWORK=testnet");
    expect(result.network).toBe("mainnet");
  });

  it("catches a testnet account whose number also exists on mainnet, through the key", async () => {
    // Account numbers overlap between networks: 0.0.1234 exists on both, as different accounts.
    const net = fakeNetwork({
      mainnet: { [ACCOUNT]: { balance: 50n * HBAR, key: { type: "ED25519", key: "ef".repeat(32) } } },
      testnet: { [ACCOUNT]: { balance: 50n * HBAR } },
    });
    const env = { ...validEnv, HEDERA_NETWORK: "mainnet" };
    const result = failure(await validateHederaEnvironment(env, { fetch: net.fetch, inspectKey: inspectMatching }));

    expect(codes(result)).toEqual(["NETWORK_MISMATCH"]);
    expect(result.issues[0].details).toMatchObject({ configuredNetwork: "mainnet", foundOn: "testnet" });
    expect(result.issues[0].message).toContain("different account");
  });

  it("keeps KEY_MISMATCH when the key controls the account nowhere else", async () => {
    const net = fakeNetwork({
      mainnet: { [ACCOUNT]: { balance: 50n * HBAR, key: { type: "ED25519", key: "ef".repeat(32) } } },
      testnet: { [ACCOUNT]: { balance: 50n * HBAR, key: { type: "ED25519", key: "12".repeat(32) } } },
    });
    const env = { ...validEnv, HEDERA_NETWORK: "mainnet" };
    expect(codes(await validateHederaEnvironment(env, { fetch: net.fetch, inspectKey: inspectMatching }))).toEqual([
      "KEY_MISMATCH",
    ]);
  });

  it("does not call an account mismatched when it exists nowhere", async () => {
    const result = failure(
      await validateHederaEnvironment(
        { ...validEnv, HEDERA_NETWORK: "mainnet" },
        { fetch: fakeNetwork().fetch, inspectKey: inspectMatching },
      ),
    );
    expect(codes(result)).toEqual(["ACCOUNT_NOT_FOUND"]);
  });

  it("detects an endpoint override that belongs to another network, without any request", async () => {
    const net = fakeNetwork();
    const env = { ...validEnv, HEDERA_MIRROR_NODE_URL: "https://mainnet.mirrornode.hedera.com" };
    const result = failure(await validateHederaEnvironment(env, { fetch: net.fetch, inspectKey: inspectMatching }));
    expect(codes(result)).toEqual(["NETWORK_MISMATCH"]);
    expect(result.issues[0].variable).toBe(ENV.MIRROR_NODE_URL);
    expect(net.calls).toEqual([]);
  });

  it("detects a JSON-RPC relay that reports another chain ID", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } }, { relayChainId: 295 });
    const env = { ...validEnv, HEDERA_RPC_URL: "https://relay.example.org/api" };
    const result = failure(await validateHederaEnvironment(env, { fetch: net.fetch, inspectKey: inspectMatching }));
    expect(codes(result)).toEqual(["NETWORK_MISMATCH"]);
    expect(result.issues[0].details).toMatchObject({ reportedChainId: 295 });
  });

  it("rejects a malformed endpoint override", async () => {
    const result = failure(
      await validateHederaEnvironment(
        { ...validEnv, HEDERA_RPC_URL: "not a url" },
        { fetch: fakeNetwork().fetch, inspectKey: inspectMatching },
      ),
    );
    expect(codes(result)).toEqual(["INVALID_URL"]);
  });
});

describe("success", () => {
  it("returns network, account, balance, status and the testnet HashScan link", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 1234n * HBAR + 50_000_000n } } });
    const result = await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching, now });

    expect(result).toEqual({
      ok: true,
      status: "valid",
      network: "testnet",
      chainId: 296,
      accountId: ACCOUNT,
      balance: { tinybars: "123450000000", hbar: "1234.5" },
      minimumBalance: { tinybars: "2000000000", hbar: "20" },
      hashscanUrl: "https://hashscan.io/testnet/account/0.0.1234",
      mirrorNodeOrigin: "https://testnet.mirrornode.hedera.com",
      keyVerified: true,
      keyType: "ED25519",
      warnings: [],
      checkedAt: "2026-09-18T12:00:00.000Z",
    });
    expect(net.calls).toEqual(["GET testnet.mirrornode.hedera.com/api/v1/accounts/0.0.1234"]);
  });

  it("reports the curve of a raw hex key from the account, so it can be parsed unambiguously", async () => {
    const net = fakeNetwork({
      testnet: { [ACCOUNT]: { balance: 100n * HBAR, key: { type: "ECDSA_SECP256K1", key: PUBLIC_KEY } } },
    });
    const inspectBoth: KeyInspector = async () => [
      { type: "ED25519", publicKey: "00".repeat(32) },
      { type: "ECDSA_SECP256K1", publicKey: PUBLIC_KEY },
    ];
    const result = await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectBoth, now });
    expect(result).toMatchObject({ ok: true, keyVerified: true, keyType: "ECDSA_SECP256K1" });
  });

  it("defaults to testnet when HEDERA_NETWORK is unset", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } });
    const { HEDERA_NETWORK: _omitted, ...env } = validEnv;
    void _omitted;
    const result = await validateHederaEnvironment(env, { fetch: net.fetch, inspectKey: inspectMatching });
    expect(result.ok && result.network).toBe("testnet");
  });

  it("points a mainnet account to the mainnet explorer and warns that real HBAR is at stake", async () => {
    const net = fakeNetwork({ mainnet: { [ACCOUNT]: { balance: 50n * HBAR } } });
    const result = await validateHederaEnvironment(
      { ...validEnv, HEDERA_NETWORK: "mainnet" },
      { fetch: net.fetch, inspectKey: inspectMatching },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.network).toBe("mainnet");
    expect(result.chainId).toBe(295);
    expect(result.hashscanUrl).toBe("https://hashscan.io/mainnet/account/0.0.1234");
    expect(result.minimumBalance.hbar).toBe("10");
    expect(result.warnings.map(w => w.code)).toEqual(["MAINNET_SELECTED"]);
  });

  it("warns instead of failing when the account uses a multi-key", async () => {
    const net = fakeNetwork({
      testnet: { [ACCOUNT]: { balance: 50n * HBAR, key: { type: "ProtobufEncoded", key: "2a00" } } },
    });
    const result = await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching });
    expect(result.ok && result.keyVerified).toBe(false);
    expect(result.ok && result.warnings.map(w => w.code)).toEqual(["KEY_UNVERIFIABLE"]);
  });

  it("produces a result that survives JSON serialization", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } });
    const result = await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching, now });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("network trouble is not a configuration error", () => {
  it.each([
    ["the Mirror Node is unreachable", { down: ["testnet" as const] }],
    ["the Mirror Node answers HTTP 503", { status: 503 }],
    ["the Mirror Node rate-limits", { status: 429 }],
  ])("reports MIRROR_UNAVAILABLE, not ACCOUNT_NOT_FOUND, when %s", async (_label, overrides) => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } }, overrides);
    const result = failure(
      await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching }),
    );
    expect(codes(result)).toEqual(["MIRROR_UNAVAILABLE"]);
    expect(result.status).toBe("unverified");
    expect(isUnverified(result)).toBe(true);
  });

  it("warns about an unreachable relay without failing the environment", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } }, { relayChainId: "down" });
    const env = { ...validEnv, HEDERA_RPC_URL: "https://relay.example.org/api" };
    const result = await validateHederaEnvironment(env, { fetch: net.fetch, inspectKey: inspectMatching });
    expect(result.ok && result.warnings.map(w => w.code)).toEqual(["RPC_UNAVAILABLE"]);
  });
});

describe("secrets never leak", () => {
  const relaySecret = "TOPSECRET-relay-token";
  const env = {
    ...validEnv,
    HEDERA_RPC_URL: `https://user:hunter2@relay.example.org/api?apikey=${relaySecret}`,
    HEDERA_MIRROR_NODE_URL: `https://mirror.example.org/v1?token=${relaySecret}`,
  };

  const scenarios: [string, () => Promise<EnvironmentValidation>][] = [
    [
      "success",
      () =>
        validateHederaEnvironment(env, {
          fetch: fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } }, { relayChainId: 296 }).fetch,
          inspectKey: inspectMatching,
        }),
    ],
    [
      "account not found",
      () => validateHederaEnvironment(env, { fetch: fakeNetwork().fetch, inspectKey: inspectMatching }),
    ],
    [
      "mirror unavailable",
      () =>
        validateHederaEnvironment(env, {
          fetch: fakeNetwork({}, { down: ["testnet"] }).fetch,
          inspectKey: inspectMatching,
        }),
    ],
    ["invalid key", () => validateHederaEnvironment(env, { fetch: fakeNetwork().fetch, inspectKey: async () => null })],
    [
      "key mismatch",
      () =>
        validateHederaEnvironment(env, {
          fetch: fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } }).fetch,
          inspectKey: async () => [{ type: "ED25519", publicKey: "ef".repeat(32) }],
        }),
    ],
    [
      "key pasted as account ID",
      () =>
        validateHederaEnvironment(
          { ...env, HEDERA_OPERATOR_ID: SECRET_KEY },
          { fetch: fakeNetwork().fetch, inspectKey: inspectMatching },
        ),
    ],
    [
      "rpc mismatch",
      () =>
        validateHederaEnvironment(env, {
          fetch: fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } }, { relayChainId: 295 }).fetch,
          inspectKey: inspectMatching,
        }),
    ],
  ];

  it.each(scenarios)("%s: result and report contain no key, credential or token", async (_name, run) => {
    const result = await run();
    const text = `${JSON.stringify(result)}\n${formatEnvironmentReport(result).join("\n")}`;
    for (const secret of [SECRET_KEY, "hunter2", relaySecret, "apikey", "user:"]) expect(text).not.toContain(secret);
  });

  it("reduces URLs to their origin", () => {
    expect(redactUrl("https://user:pw@host.example/a/b?k=v")).toBe("https://host.example");
    expect(redactUrl("garbage")).toBe("<invalid url>");
  });
});

describe("the default key inspector (Hedera SDK)", () => {
  it("derives the public key of DER-encoded keys of both curves", async () => {
    const ed = PrivateKey.generateED25519();
    const ec = PrivateKey.generateECDSA();
    expect(await inspectPrivateKey(ed.toStringDer())).toEqual([
      { type: "ED25519", publicKey: ed.publicKey.toStringRaw() },
    ]);
    expect(await inspectPrivateKey(ec.toStringDer())).toEqual([
      { type: "ECDSA_SECP256K1", publicKey: ec.publicKey.toStringRaw() },
    ]);
  });

  it("offers both curves for a raw 32-byte key, so the account's key decides", async () => {
    const ed = PrivateKey.generateED25519();
    const candidates = await inspectPrivateKey(`0x${ed.toStringRaw()}`);
    expect(candidates?.map(c => c.type)).toEqual(["ED25519", "ECDSA_SECP256K1"]);
    expect(candidates?.[0].publicKey).toBe(ed.publicKey.toStringRaw());
  });

  it("returns null for anything that is not a private key, without throwing", async () => {
    for (const value of ["", "not a key", "0.0.1234", "abcd", "30zz"])
      expect(await inspectPrivateKey(value)).toBeNull();
  });

  it("verifies a real key against the account's key end to end", async () => {
    const ed = PrivateKey.generateED25519();
    const net = fakeNetwork({
      testnet: { [ACCOUNT]: { balance: 50n * HBAR, key: { type: "ED25519", key: ed.publicKey.toStringRaw() } } },
    });
    const env = { ...validEnv, HEDERA_OPERATOR_KEY: ed.toStringRaw() };
    const result = await validateHederaEnvironment(env, { fetch: net.fetch });
    expect(result.ok && result.keyVerified).toBe(true);

    const other = { ...env, HEDERA_OPERATOR_KEY: PrivateKey.generateED25519().toStringRaw() };
    expect(codes(await validateHederaEnvironment(other, { fetch: net.fetch }))).toEqual(["KEY_MISMATCH"]);
  });
});

describe("HBAR helpers", () => {
  it("formats and parses without floating point", () => {
    expect(formatHbar(0n)).toBe("0");
    expect(formatHbar(1n)).toBe("0.00000001");
    expect(formatHbar(150_000_000n)).toBe("1.5");
    expect(parseHbar("20")).toBe(2_000_000_000n);
    expect(parseHbar("0.00000001")).toBe(1n);
    expect(parseHbar("0")).toBeNull();
    expect(parseHbar("-1")).toBeNull();
    expect(parseHbar("1.123456789")).toBeNull();
    expect(parseHbar("1e3")).toBeNull();
  });
});

describe("report", () => {
  it("shows account, network and HashScan on success", async () => {
    const net = fakeNetwork({ testnet: { [ACCOUNT]: { balance: 50n * HBAR } } });
    const text = formatEnvironmentReport(
      await validateHederaEnvironment(validEnv, { fetch: net.fetch, inspectKey: inspectMatching }),
    ).join("\n");
    expect(text).toContain("testnet (chain ID 296)");
    expect(text).toContain(ACCOUNT);
    expect(text).toContain("https://hashscan.io/testnet/account/0.0.1234");
  });

  it("pairs every failure with the action to take", async () => {
    const lines = formatEnvironmentReport(await validateHederaEnvironment({}, { fetch: fakeNetwork().fetch })).join(
      "\n",
    );
    expect(lines).toContain("[MISSING_ENV] HEDERA_OPERATOR_ID");
    expect(lines).toContain("Fix: ");
  });
});

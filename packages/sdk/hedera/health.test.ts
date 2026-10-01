import { AbiCoder, Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_REGISTRY_ABI } from "./audit/registry";
import type { GeneratedDeployments } from "./contracts";
import type { KeyInspector } from "./environment";
import { INTEGRATION_IDS, checkHederaHealth, lookupEvmAccount } from "./health";
import type { HederaHealthReport } from "./health";
import { NETWORKS } from "./networks";

const ACCOUNT = "0.0.1234";
const PUBLIC_KEY = "ab".repeat(32);
const SECRET_KEY = "cd".repeat(32);
const TOPIC = "0.0.4567";
const REGISTRY = `0x${"12".repeat(20)}`;
const HBAR = 100_000_000n;

const now = () => new Date("2026-09-18T12:00:00.000Z");
const NOW_S = Math.floor(now().getTime() / 1000);

const MIRROR = new URL(NETWORKS.testnet.mirrorNodeUrl).host;
const RELAY = new URL(NETWORKS.testnet.rpcUrl).host;

const REGISTRY_IFACE = new Interface(CREDENTIAL_REGISTRY_ABI);
const SELECTOR = {
  hcsTopicNum: REGISTRY_IFACE.getFunction("hcsTopicNum")!.selector,
  paused: REGISTRY_IFACE.getFunction("paused")!.selector,
};
const abi = AbiCoder.defaultAbiCoder();

type Key = { type: string; key: string } | null;

interface FakeOptions {
  balance?: bigint;
  mirror?: "up" | "down" | "not-a-mirror";
  lagSeconds?: number;
  relayChainId?: number | "down";
  /** `false`: no contract at the address (eth_call answers `0x`). */
  registry?: { topicNum?: bigint; paused?: boolean } | false;
  topic?: { submitKey?: Key; deleted?: boolean } | "missing";
  contractId?: string | null;
  /** Hosts that answer like the testnet ones (endpoint overrides). */
  mirrorHost?: string;
  relayHost?: string;
  /** Generated deployment manifest; empty by default so tests do not depend on the committed one. */
  manifest?: GeneratedDeployments;
}

/** In-memory Mirror Node and relay for the selected testnet. Records every request as `METHOD host/path`. */
function fakeNetwork(options: FakeOptions = {}) {
  const calls: string[] = [];
  const mirrorHost = options.mirrorHost ?? MIRROR;
  const relayHost = options.relayHost ?? RELAY;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);

    if (url.host === relayHost && init?.method === "POST") {
      if (options.relayChainId === "down") throw new Error("connect ECONNREFUSED");
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: [{ data: string }] };
      const answer = (result: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      if (method === "eth_chainId") return answer(`0x${(options.relayChainId ?? 296).toString(16)}`);
      if (method === "eth_call") {
        if (options.registry === false) return answer("0x");
        const registry = options.registry ?? {};
        const data = params[0].data;
        if (data === SELECTOR.hcsTopicNum) return answer(abi.encode(["uint64"], [registry.topicNum ?? 4567n]));
        if (data === SELECTOR.paused) return answer(abi.encode(["bool"], [registry.paused ?? false]));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601 } }));
    }

    if (url.host !== mirrorHost || options.mirror === "down") throw new Error("connect ECONNREFUSED");
    if (options.mirror === "not-a-mirror") return new Response("<html>hello</html>");
    const path = url.pathname.replace(/^\/api\/v1/, "");

    if (path === "/blocks") {
      const to = `${NOW_S - (options.lagSeconds ?? 4)}.000000001`;
      return new Response(JSON.stringify({ blocks: [{ number: 987, timestamp: { from: "1.0", to } }] }));
    }
    if (path === `/accounts/${ACCOUNT}`) {
      return new Response(
        `{"account":"${ACCOUNT}","deleted":false,"balance":{"balance":${options.balance ?? 100n * HBAR},"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${PUBLIC_KEY}"}}`,
      );
    }
    if (path === `/topics/${TOPIC}`) {
      if (options.topic === "missing") return new Response("{}", { status: 404 });
      const topic = options.topic ?? {};
      const submitKey = topic.submitKey === undefined ? { type: "ED25519", key: PUBLIC_KEY } : topic.submitKey;
      return new Response(
        JSON.stringify({
          topic_id: TOPIC,
          memo: "evidence",
          deleted: topic.deleted ?? false,
          submit_key: submitKey && { _type: submitKey.type, key: submitKey.key },
        }),
      );
    }
    if (path === `/contracts/${REGISTRY}`) {
      const contractId = options.contractId === undefined ? "0.0.7777" : options.contractId;
      return contractId
        ? new Response(JSON.stringify({ contract_id: contractId, evm_address: REGISTRY }))
        : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const inspectMatching: KeyInspector = async key =>
  key === SECRET_KEY ? [{ type: "ED25519", publicKey: PUBLIC_KEY }] : null;

const fullEnv = {
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: ACCOUNT,
  HEDERA_OPERATOR_KEY: SECRET_KEY,
  HEDERA_HCS_TOPIC_ID: TOPIC,
  HEDERA_CREDENTIAL_REGISTRY_ADDRESS: REGISTRY,
};

async function check(env: Record<string, string | undefined>, options: FakeOptions = {}) {
  const net = fakeNetwork(options);
  const report = await checkHederaHealth(env, {
    fetch: net.fetch,
    inspectKey: inspectMatching,
    now,
    manifest: options.manifest ?? {},
  });
  return { report, calls: net.calls };
}

const statuses = (report: HederaHealthReport) =>
  Object.fromEntries(INTEGRATION_IDS.map(id => [id, report.integrations[id].status]));

describe("checkHederaHealth — fully configured environment", () => {
  it("reports every integration ok, with HashScan links and no hardcoded identifiers", async () => {
    const { report } = await check(fullEnv);

    expect(report.overall).toBe("ok");
    expect(statuses(report)).toEqual({ environment: "ok", mirror: "ok", relay: "ok", hcs: "ok", registry: "ok" });
    expect(report.network).toEqual({
      name: "testnet",
      chainId: 296,
      hashscanUrl: "https://hashscan.io/testnet",
      mirrorNodeOrigin: "https://testnet.mirrornode.hedera.com",
      rpcOrigin: "https://testnet.hashio.io",
    });
    expect(report.operator).toEqual({
      accountId: ACCOUNT,
      balance: { tinybars: (100n * HBAR).toString(), hbar: "100" },
      minimumBalance: { tinybars: (20n * HBAR).toString(), hbar: "20" },
      keyVerified: true,
      hashscanUrl: `https://hashscan.io/testnet/account/${ACCOUNT}`,
    });
    expect(report.integrations.hcs.links).toEqual([
      { label: "Topic on HashScan", url: `https://hashscan.io/testnet/topic/${TOPIC}` },
    ]);
    expect(report.integrations.registry.links).toEqual([
      { label: "Contract on HashScan", url: "https://hashscan.io/testnet/contract/0.0.7777" },
    ]);
    expect(report.integrations.registry.details).toEqual({
      address: REGISTRY,
      source: "env",
      contractId: "0.0.7777",
      hcsTopic: TOPIC,
      paused: false,
    });
    expect(report.integrations.mirror.details).toMatchObject({ latestBlock: 987, lagSeconds: 4 });
    expect(report.checkedAt).toBe("2026-09-18T12:00:00.000Z");
  });

  it("follows the selected network: mainnet links and chain id come from networks.ts", async () => {
    const mainnetMirror = new URL(NETWORKS.mainnet.mirrorNodeUrl).host;
    const mainnetRelay = new URL(NETWORKS.mainnet.rpcUrl).host;
    const { report } = await check(
      { ...fullEnv, HEDERA_NETWORK: "mainnet" },
      { mirrorHost: mainnetMirror, relayHost: mainnetRelay, relayChainId: 295, balance: 50n * HBAR },
    );
    expect(report.network?.chainId).toBe(295);
    expect(report.integrations.hcs.links[0].url).toBe(`https://hashscan.io/mainnet/topic/${TOPIC}`);
    expect(report.integrations.environment.warnings[0]).toMatch(/mainnet/);
    expect(report.overall).toBe("ok");
  });

  it("links the contract by EVM address while the Mirror Node has not indexed it yet", async () => {
    const { report } = await check(fullEnv, { contractId: null });
    expect(report.integrations.registry.status).toBe("ok");
    expect(report.integrations.registry.links[0].url).toBe(`https://hashscan.io/testnet/contract/${REGISTRY}`);
    expect(report.integrations.registry.details).not.toHaveProperty("contractId");
  });

  it("uses the address recorded by `yarn deploy` when HEDERA_CREDENTIAL_REGISTRY_ADDRESS is unset", async () => {
    const record = { address: REGISTRY, contractId: "0.0.7777", deployTxHash: null, blockNumber: 1, abiHash: REGISTRY };
    const manifest = { testnet: { CredentialRegistry: record } } as GeneratedDeployments;
    const { report } = await check({ ...fullEnv, HEDERA_CREDENTIAL_REGISTRY_ADDRESS: undefined }, { manifest });
    expect(report.integrations.registry.status).toBe("ok");
    expect(report.integrations.registry.details).toMatchObject({ address: REGISTRY, source: "manifest" });

    // An explicit variable always wins over the manifest.
    const other = "0x" + "9".repeat(40);
    const explicit = await check({ ...fullEnv, HEDERA_CREDENTIAL_REGISTRY_ADDRESS: other }, { manifest });
    expect(explicit.report.integrations.registry.details).toMatchObject({ address: other, source: "env" });
  });

  it("produces plain JSON (no bigint), safe to send to a browser", async () => {
    const { report } = await check(fullEnv);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

describe("checkHederaHealth — not configured", () => {
  it("marks each unconfigured integration as not_configured, without querying for it", async () => {
    const { report, calls } = await check({ HEDERA_NETWORK: "testnet" });

    expect(statuses(report)).toEqual({
      environment: "not_configured",
      mirror: "ok",
      relay: "ok",
      hcs: "not_configured",
      registry: "not_configured",
    });
    expect(report.overall).toBe("not_configured");
    expect(report.integrations.hcs.remediation).toMatch(/yarn hcs:topic/);
    expect(report.integrations.registry.variable).toBe("HEDERA_CREDENTIAL_REGISTRY_ADDRESS");
    expect(report.integrations.registry.remediation).toMatch(/yarn deploy --network hederaTestnet/);
    expect(report.integrations.environment.variable).toBe("HEDERA_OPERATOR_ID");
    expect(calls.some(c => c.includes("/topics/") || c.includes("/contracts/") || c.includes("/accounts/"))).toBe(
      false,
    );
    expect(report.operator).toEqual({
      accountId: null,
      balance: null,
      minimumBalance: null,
      keyVerified: false,
      hashscanUrl: null,
    });
  });

  it("does not require the operator key: a read-only deployment still checks the account", async () => {
    const { report } = await check({ ...fullEnv, HEDERA_OPERATOR_KEY: undefined });
    expect(report.integrations.environment.status).toBe("ok");
    expect(report.operator.keyVerified).toBe(false);
    // Without a key the topic's submitKey cannot be compared; the topic itself is fine.
    expect(report.integrations.hcs.status).toBe("ok");
    expect(report.integrations.hcs.warnings[0]).toMatch(/not compared/);
  });

  it("checks nothing else when HEDERA_NETWORK is not supported, and names the variable", async () => {
    const { report, calls } = await check({ ...fullEnv, HEDERA_NETWORK: "devnet" });
    expect(report.network).toBeNull();
    expect(report.overall).toBe("error");
    for (const id of ["mirror", "relay", "hcs", "registry"] as const) {
      expect(report.integrations[id].status).toBe("error");
      expect(report.integrations[id].variable).toBe("HEDERA_NETWORK");
    }
    expect(report.environment.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("checkHederaHealth — errors", () => {
  it("separates an unreachable Mirror Node (transient) from a broken configuration", async () => {
    const { report } = await check(fullEnv, { mirror: "down" });
    expect(report.integrations.mirror).toMatchObject({ status: "error", transient: true });
    expect(report.integrations.environment).toMatchObject({ status: "error", transient: true });
    expect(report.integrations.hcs).toMatchObject({ status: "error", transient: true });
    expect(report.integrations.relay.status).toBe("ok");
    expect(report.integrations.registry.status).toBe("ok");
  });

  it("recognises an endpoint that is not a Mirror Node as a configuration error", async () => {
    const { report } = await check(fullEnv, { mirror: "not-a-mirror" });
    expect(report.integrations.mirror).toMatchObject({ status: "error", variable: "HEDERA_MIRROR_NODE_URL" });
    expect(report.integrations.mirror.transient).toBeUndefined();
  });

  it("warns when the Mirror Node lags beyond the audit's index budget", async () => {
    const { report } = await check(fullEnv, { lagSeconds: 125 });
    expect(report.integrations.mirror.status).toBe("ok");
    expect(report.integrations.mirror.warnings[0]).toMatch(/125s behind .*pending/);
  });

  it("flags a relay serving another chain, and one that does not answer", async () => {
    const wrong = await check(fullEnv, { relayChainId: 295 });
    expect(wrong.report.integrations.relay).toMatchObject({ status: "error", variable: "HEDERA_RPC_URL" });
    expect(wrong.report.integrations.relay.summary).toMatch(/chain ID 295/);

    const down = await check(fullEnv, { relayChainId: "down" });
    expect(down.report.integrations.relay).toMatchObject({ status: "error", transient: true });
    expect(down.report.integrations.registry).toMatchObject({ status: "error", transient: true });
  });

  it("reuses the topic checks of #6: missing topic, no submitKey, foreign submitKey", async () => {
    const missing = await check(fullEnv, { topic: "missing" });
    expect(missing.report.integrations.hcs.status).toBe("error");
    expect(missing.report.integrations.hcs.summary).toMatch(/does not exist on testnet/);

    const open = await check(fullEnv, { topic: { submitKey: null } });
    expect(open.report.integrations.hcs.summary).toMatch(/no submitKey/);

    const foreign = await check(fullEnv, { topic: { submitKey: { type: "ED25519", key: "ef".repeat(32) } } });
    expect(foreign.report.integrations.hcs.status).toBe("error");
    expect(foreign.report.integrations.hcs.summary).toMatch(/not the submitKey/);
  });

  it("detects an address without a CredentialRegistry on the selected network", async () => {
    const { report } = await check(fullEnv, { registry: false, contractId: null });
    expect(report.integrations.registry).toMatchObject({
      status: "error",
      variable: "HEDERA_CREDENTIAL_REGISTRY_ADDRESS",
    });
    expect(report.integrations.registry.transient).toBe(false);
    expect(report.integrations.registry.summary).toMatch(/No CredentialRegistry answers/);
  });

  it("detects a registry deployed for another HCS topic", async () => {
    const { report } = await check(fullEnv, { registry: { topicNum: 9999n } });
    expect(report.integrations.registry.status).toBe("error");
    expect(report.integrations.registry.summary).toBe(
      `CredentialRegistry was deployed for topic 0.0.9999, but HEDERA_HCS_TOPIC_ID is ${TOPIC}.`,
    );
  });

  it("rejects an invalid registry address without a request", async () => {
    const { report, calls } = await check({ ...fullEnv, HEDERA_CREDENTIAL_REGISTRY_ADDRESS: "0xnothex" });
    expect(report.integrations.registry.status).toBe("error");
    expect(calls.some(c => c.includes("/contracts/"))).toBe(false);
  });

  it("warns that issuance is paused without calling it an error", async () => {
    const { report } = await check(fullEnv, { registry: { paused: true } });
    expect(report.integrations.registry.status).toBe("ok");
    expect(report.integrations.registry.warnings).toEqual(["Issuance is paused (revocation still works)."]);
  });

  it("still shows the balance when it is below the minimum", async () => {
    const { report } = await check(fullEnv, { balance: 3n * HBAR });
    expect(report.integrations.environment.status).toBe("error");
    expect(report.operator.balance?.hbar).toBe("3");
    expect(report.operator.minimumBalance?.hbar).toBe("20");
    expect(report.operator.hashscanUrl).toBe(`https://hashscan.io/testnet/account/${ACCOUNT}`);
  });
});

describe("checkHederaHealth — remediation", () => {
  it("gives every integration that is not ok a remediation", async () => {
    const scenarios: [Record<string, string | undefined>, FakeOptions][] = [
      [{}, {}],
      [{ ...fullEnv, HEDERA_NETWORK: "devnet" }, {}],
      [fullEnv, { mirror: "down", relayChainId: "down" }],
      [fullEnv, { mirror: "not-a-mirror", relayChainId: 295 }],
      [fullEnv, { topic: "missing", registry: false }],
      [fullEnv, { topic: { submitKey: null }, registry: { topicNum: 1n } }],
      [{ ...fullEnv, HEDERA_HCS_TOPIC_ID: "nope", HEDERA_CREDENTIAL_REGISTRY_ADDRESS: "0x0" }, { balance: 1n }],
    ];
    for (const [env, options] of scenarios) {
      const { report } = await check(env, options);
      for (const id of INTEGRATION_IDS) {
        const item = report.integrations[id];
        if (item.status !== "ok") expect(item.remediation, `${id}: ${item.summary}`).toBeTruthy();
      }
    }
  });

  it("links the faucet on testnet only", async () => {
    expect((await check(fullEnv)).report.faucetUrl).toBe("https://portal.hedera.com/faucet");
    const mainnet = await check({ ...fullEnv, HEDERA_NETWORK: "mainnet" });
    expect(mainnet.report.faucetUrl).toBeNull();
  });
});

describe("lookupEvmAccount", () => {
  const ADDRESS = `0x${"AB".repeat(20)}`;
  const mirror = (answer: () => Response) => {
    const calls: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return answer();
    }) as typeof fetch;
    return { impl, calls };
  };

  it("resolves the account id through the configured Mirror Node", async () => {
    const m = mirror(() => new Response(JSON.stringify({ account: "0.0.4321", evm_address: ADDRESS })));
    expect(await lookupEvmAccount({ HEDERA_NETWORK: "testnet" }, ADDRESS, { fetch: m.impl })).toEqual({
      status: "found",
      accountId: "0.0.4321",
      hashscanUrl: "https://hashscan.io/testnet/account/0.0.4321",
    });
    expect(m.calls).toEqual([
      `https://testnet.mirrornode.hedera.com/api/v1/accounts/${ADDRESS.toLowerCase()}?transactions=false`,
    ]);
  });

  it("reports an address without a Hedera account as not_found, not as an error", async () => {
    const m = mirror(() => new Response("{}", { status: 404 }));
    expect(await lookupEvmAccount({}, ADDRESS, { fetch: m.impl })).toEqual({ status: "not_found" });
  });

  it("rejects anything but an EVM address without a request, and never throws", async () => {
    const m = mirror(() => new Response("<html/>"));
    expect(await lookupEvmAccount({}, "0.0.1234", { fetch: m.impl })).toEqual({ status: "invalid" });
    expect(await lookupEvmAccount({}, `${ADDRESS}/../x`, { fetch: m.impl })).toEqual({ status: "invalid" });
    expect(m.calls).toEqual([]);
    expect(await lookupEvmAccount({}, ADDRESS, { fetch: m.impl })).toEqual({ status: "unavailable" });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await lookupEvmAccount({}, ADDRESS, { fetch: down })).toEqual({ status: "unavailable" });
  });
});

describe("checkHederaHealth — secrets", () => {
  it("never puts the private key, or an endpoint path or query, in the report", async () => {
    const env = {
      ...fullEnv,
      HEDERA_MIRROR_NODE_URL: "https://mirror.example.com/api-key/MIRRORSECRET",
      HEDERA_RPC_URL: "https://relay.example.com/v1/RELAYSECRET?token=QUERYSECRET",
    };
    for (const options of [
      { mirrorHost: "mirror.example.com", relayHost: "relay.example.com" },
      { mirror: "down" as const, relayChainId: "down" as const },
    ]) {
      const { report } = await check(env, options);
      const serialized = JSON.stringify(report);
      for (const secret of [SECRET_KEY, "MIRRORSECRET", "RELAYSECRET", "QUERYSECRET", "api-key"]) {
        expect(serialized).not.toContain(secret);
      }
      expect(report.network?.rpcOrigin).toBe("https://relay.example.com");
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  HBAR,
  HEALTH_ACCOUNT as ACCOUNT,
  HEALTH_REGISTRY as REGISTRY,
  HEALTH_SECRET_KEY as SECRET_KEY,
  HEALTH_TOPIC as TOPIC,
  healthEnv as fullEnv,
  healthReport as check,
} from "../testing/network";
import type { FakeNetworkOptions as FakeOptions } from "../testing/network";
import type { GeneratedDeployments } from "./contracts";
import { INTEGRATION_IDS, lookupEvmAccount } from "./health";
import type { HederaHealthReport } from "./health";
import { NETWORKS } from "./networks";

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

/**
 * A deterministic, in-memory Hedera environment (Mirror Node + JSON-RPC relay) for `checkHederaHealth` and
 * `lookupEvmAccount`, plus ready-made health reports for the dashboard tests. Nothing here reaches a network.
 */
import { AbiCoder, Interface } from "ethers";
import { CREDENTIAL_REGISTRY_ABI } from "../hedera/audit/registry";
import type { GeneratedDeployments } from "../hedera/contracts";
import type { EnvironmentVariables, KeyInspector } from "../hedera/environment";
import { checkHederaHealth } from "../hedera/health";
import type { HederaHealthReport } from "../hedera/health";
import { NETWORKS } from "../hedera/networks";

export const HEALTH_ACCOUNT = "0.0.1234";
export const HEALTH_PUBLIC_KEY = "ab".repeat(32);
/** A fake operator key: it controls nothing and exists so tests can prove it never leaks into a report. */
export const HEALTH_SECRET_KEY = "cd".repeat(32);
export const HEALTH_TOPIC = "0.0.4567";
export const HEALTH_REGISTRY = `0x${"12".repeat(20)}`;
export const HBAR = 100_000_000n;

export const healthNow = () => new Date("2026-09-18T12:00:00.000Z");
const NOW_S = Math.floor(healthNow().getTime() / 1000);

const MIRROR = new URL(NETWORKS.testnet.mirrorNodeUrl).host;
const RELAY = new URL(NETWORKS.testnet.rpcUrl).host;

const REGISTRY_IFACE = new Interface(CREDENTIAL_REGISTRY_ABI);
const SELECTOR = {
  hcsTopicNum: REGISTRY_IFACE.getFunction("hcsTopicNum")!.selector,
  paused: REGISTRY_IFACE.getFunction("paused")!.selector,
};
const abi = AbiCoder.defaultAbiCoder();

type Key = { type: string; key: string } | null;

export interface FakeNetworkOptions {
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
export function fakeHederaNetwork(options: FakeNetworkOptions = {}) {
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
    if (path === `/accounts/${HEALTH_ACCOUNT}`) {
      return new Response(
        `{"account":"${HEALTH_ACCOUNT}","deleted":false,"balance":{"balance":${options.balance ?? 100n * HBAR},"timestamp":"1.0","tokens":[]},"key":{"_type":"ED25519","key":"${HEALTH_PUBLIC_KEY}"}}`,
      );
    }
    if (path === `/topics/${HEALTH_TOPIC}`) {
      if (options.topic === "missing") return new Response("{}", { status: 404 });
      const topic = options.topic ?? {};
      const submitKey = topic.submitKey === undefined ? { type: "ED25519", key: HEALTH_PUBLIC_KEY } : topic.submitKey;
      return new Response(
        JSON.stringify({
          topic_id: HEALTH_TOPIC,
          memo: "evidence",
          deleted: topic.deleted ?? false,
          submit_key: submitKey && { _type: submitKey.type, key: submitKey.key },
        }),
      );
    }
    if (path === `/contracts/${HEALTH_REGISTRY}`) {
      const contractId = options.contractId === undefined ? "0.0.7777" : options.contractId;
      return contractId
        ? new Response(JSON.stringify({ contract_id: contractId, evm_address: HEALTH_REGISTRY }))
        : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const inspectMatchingKey: KeyInspector = async key =>
  key === HEALTH_SECRET_KEY ? [{ type: "ED25519", publicKey: HEALTH_PUBLIC_KEY }] : null;

/** Every variable the dashboard checks, pointing at the fake network. */
export const healthEnv: EnvironmentVariables = {
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: HEALTH_ACCOUNT,
  HEDERA_OPERATOR_KEY: HEALTH_SECRET_KEY,
  HEDERA_HCS_TOPIC_ID: HEALTH_TOPIC,
  HEDERA_CREDENTIAL_REGISTRY_ADDRESS: HEALTH_REGISTRY,
};

/** `healthEnv` without the operator key: the read-only setup a dashboard deployment typically runs with. */
export const healthEnvWithoutKey: EnvironmentVariables = Object.fromEntries(
  Object.entries(healthEnv).filter(([name]) => name !== "HEDERA_OPERATOR_KEY"),
);

/** Runs the real `checkHederaHealth` against the fake network. */
export async function healthReport(
  env: EnvironmentVariables = healthEnv,
  options: FakeNetworkOptions = {},
): Promise<{ report: HederaHealthReport; calls: string[] }> {
  const net = fakeHederaNetwork(options);
  const report = await checkHederaHealth(env, {
    fetch: net.fetch,
    inspectKey: inspectMatchingKey,
    now: healthNow,
    manifest: options.manifest ?? {},
  });
  return { report, calls: net.calls };
}

/** Named reports covering each state the dashboard renders. */
export const HEALTH_SCENARIOS = {
  healthy: () => healthReport(),
  unconfigured: () => healthReport({ HEDERA_NETWORK: "testnet" }),
  invalidNetwork: () => healthReport({ ...healthEnv, HEDERA_NETWORK: "devnet" }),
  mirrorDown: () => healthReport(healthEnv, { mirror: "down" }),
  lowBalance: () => healthReport(healthEnv, { balance: 3n * HBAR }),
  registryMissing: () => healthReport(healthEnv, { registry: false, contractId: null }),
} satisfies Record<string, () => Promise<{ report: HederaHealthReport }>>;

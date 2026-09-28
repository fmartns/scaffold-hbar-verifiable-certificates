/**
 * Infrastructure health of the Hedera environment, for the developer dashboard (#11) and any other read-only consumer.
 *
 * It COMPOSES the existing checks instead of re-implementing them: the operator account, key and balance come from
 * `validateHederaEnvironment` (#5), the evidence topic from `verifyHcsTopic` (#6), the registry from the audit's
 * relay reader (#10). What it adds is one status per integration (`ok` / `error` / `not_configured`) and the Mirror Node
 * indexing lag, which decides whether an audit will see recent records or report them as pending.
 *
 * Read-only and secret-free: it needs no operator key (when one is configured it is used only to compare public keys),
 * every URL in the report is reduced to its origin, and the report is plain JSON, safe to render or serialize.
 */
import { getAddress } from "ethers";
import { DEFAULT_INDEX_BUDGET_SECONDS } from "./audit/audit";
import { CREDENTIAL_AUDIT_ENV } from "./audit/config";
import { RegistryReadError, readRegistryDeployment } from "./audit/registry";
import type { RegistryDeployment } from "./audit/registry";
import {
  ENV,
  FAUCET_URL,
  fetchRelayChainId,
  inspectPrivateKey,
  redactUrl,
  validateHederaEnvironment,
} from "./environment";
import type { EnvironmentValidation, EnvironmentVariables, HbarAmount, KeyInspector } from "./environment";
import { hashscanAccountUrl, hashscanContractUrl, hashscanTopicUrl } from "./explorer";
import { formatHbar } from "./hbar";
import { HCS_ENV, isValidTopicId } from "./hcs/config";
import { verifyHcsTopic } from "./hcs/topic-check";
import { getSelectedNetwork } from "./networks";
import type { HederaNetwork, HederaNetworkName } from "./networks";

export type HealthStatus = "ok" | "error" | "not_configured";

export type IntegrationId = "environment" | "mirror" | "relay" | "hcs" | "registry";

/** Display order. */
export const INTEGRATION_IDS: readonly IntegrationId[] = ["environment", "mirror", "relay", "hcs", "registry"];

export interface HealthLink {
  label: string;
  url: string;
}

export interface IntegrationHealth {
  id: IntegrationId;
  label: string;
  status: HealthStatus;
  /** One line: what was found. Contains no secret and no URL beyond an origin. */
  summary: string;
  /** What to do about an `error` or `not_configured`. */
  remediation?: string;
  /** The environment variable to look at, when there is one. */
  variable?: string;
  /** The error is a connectivity problem only: retrying may clear it and the configuration is not proven wrong. */
  transient?: boolean;
  warnings: string[];
  links: HealthLink[];
  details: Record<string, string | number | boolean>;
}

export interface OperatorSummary {
  accountId: string | null;
  balance: HbarAmount | null;
  minimumBalance: HbarAmount | null;
  keyVerified: boolean;
  hashscanUrl: string | null;
}

export interface HederaHealthReport {
  /** `null` when `HEDERA_NETWORK` is not a supported network; nothing else is checked then. */
  network: {
    name: HederaNetworkName;
    chainId: number;
    hashscanUrl: string | null;
    mirrorNodeOrigin: string;
    rpcOrigin: string;
  } | null;
  /** The validator's result, unchanged: the dashboard lists its issues and warnings as-is. */
  environment: EnvironmentValidation;
  operator: OperatorSummary;
  integrations: Record<IntegrationId, IntegrationHealth>;
  /** `error` if any integration errs, else `not_configured` if any is not configured, else `ok`. */
  overall: HealthStatus;
  /** Where to get test HBAR; testnet only. */
  faucetUrl: string | null;
  checkedAt: string;
}

export interface HealthCheckOptions {
  fetch?: typeof fetch;
  /** Per-request timeout. Default 5 000 ms: a dashboard must answer quickly. */
  timeoutMs?: number;
  now?: () => Date;
  inspectKey?: KeyInspector;
  /** Mirror Node lag above which a warning is raised. Default: the audit's index budget. */
  indexBudgetSeconds?: number;
}

export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

const LABELS: Record<IntegrationId, string> = {
  environment: "Operator account",
  mirror: "Mirror Node",
  relay: "JSON-RPC relay",
  hcs: "HCS evidence topic",
  registry: "CredentialRegistry",
};

function integration(
  id: IntegrationId,
  status: HealthStatus,
  summary: string,
  extra: Partial<Omit<IntegrationHealth, "id" | "label" | "status" | "summary">> = {},
): IntegrationHealth {
  return { id, label: LABELS[id], status, summary, warnings: [], links: [], details: {}, ...extra };
}

const link = (label: string, url: string | null): HealthLink[] => (url ? [{ label, url }] : []);

const failureReason = (error: unknown) =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "network error";

// ---------------------------------------------------------------------------------------------------------------------
// Operator account (validator of #5)
// ---------------------------------------------------------------------------------------------------------------------

function environmentHealth(result: EnvironmentValidation): IntegrationHealth {
  const warnings = result.warnings.map(w => w.message);
  if (result.ok) {
    return integration(
      "environment",
      "ok",
      `Account ${result.accountId} holds ${result.balance.hbar} HBAR on ${result.network} (minimum ${result.minimumBalance.hbar}).`,
      {
        warnings,
        links: link("Account on HashScan", result.hashscanUrl),
        details: { keyVerified: result.keyVerified },
      },
    );
  }
  const [first] = result.issues;
  const onlyMissing = result.issues.every(i => i.code === "MISSING_ENV");
  return integration("environment", onlyMissing ? "not_configured" : "error", first?.message ?? "Not valid.", {
    warnings,
    remediation: first?.remediation,
    variable: first?.variable,
    transient: result.status === "unverified",
    details: { issues: result.issues.length },
  });
}

function operatorSummary(result: EnvironmentValidation, network: HederaNetwork | null): OperatorSummary {
  if (result.ok) {
    return {
      accountId: result.accountId,
      balance: result.balance,
      minimumBalance: result.minimumBalance,
      keyVerified: result.keyVerified,
      hashscanUrl: result.hashscanUrl,
    };
  }
  // The balance is known even when it is the problem.
  const low = result.issues.find(i => i.code === "INSUFFICIENT_BALANCE")?.details;
  const amount = (value: unknown): HbarAmount | null =>
    typeof value === "string" && /^\d+$/.test(value) ? { tinybars: value, hbar: formatHbar(BigInt(value)) } : null;
  const accountId = result.accountId ?? null;
  return {
    accountId,
    balance: amount(low?.balanceTinybars),
    minimumBalance: amount(low?.minimumTinybars),
    keyVerified: false,
    hashscanUrl: accountId && network ? hashscanAccountUrl(network, accountId) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Mirror Node and relay
// ---------------------------------------------------------------------------------------------------------------------

async function mirrorHealth(
  network: HederaNetwork,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  nowMs: number,
  budgetSeconds: number,
): Promise<IntegrationHealth> {
  const origin = redactUrl(network.mirrorNodeUrl);
  const unreachable = (reason: string) =>
    integration("mirror", "error", `No usable answer from the Mirror Node at ${origin} (${reason}).`, {
      remediation: `Check your connection and retry. To use another endpoint set ${ENV.MIRROR_NODE_URL}.`,
      variable: ENV.MIRROR_NODE_URL,
      transient: true,
      details: { origin },
    });

  let response: Response;
  try {
    response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1/blocks?limit=1&order=desc`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return unreachable(failureReason(error));
  }
  if (response.status === 429) return unreachable("rate limited (HTTP 429)");
  if (!response.ok) return unreachable(`HTTP ${response.status}`);

  let body: { blocks?: { number?: unknown; timestamp?: { to?: unknown } }[] };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (!Array.isArray(body.blocks)) {
    return integration("mirror", "error", `The endpoint at ${origin} does not answer like a Mirror Node.`, {
      remediation: `Point ${ENV.MIRROR_NODE_URL} to the Mirror Node REST base URL of the selected network, or unset it.`,
      variable: ENV.MIRROR_NODE_URL,
      details: { origin },
    });
  }
  const [latest] = body.blocks;
  const to = typeof latest?.timestamp?.to === "string" ? /^(\d+)\.\d+$/.exec(latest.timestamp.to) : null;
  if (!latest || !to) {
    return integration("mirror", "ok", `Answering at ${origin}; no block indexed yet.`, {
      warnings: ["The Mirror Node has not indexed any block: records will show as pending until it does."],
      details: { origin },
    });
  }
  const lagSeconds = Math.max(0, Math.floor(nowMs / 1000) - Number(to[1]));
  const block = typeof latest.number === "number" ? latest.number : Number(latest.number);
  return integration("mirror", "ok", `Answering at ${origin}; latest block ${block}, ${lagSeconds}s behind now.`, {
    warnings:
      lagSeconds > budgetSeconds
        ? [
            `The Mirror Node is ${lagSeconds}s behind (index budget ${budgetSeconds}s): recent records will show as pending in audits.`,
          ]
        : [],
    details: { origin, latestBlock: block, lagSeconds },
  });
}

async function relayHealth(network: HederaNetwork, fetchImpl: typeof fetch, timeoutMs: number) {
  const origin = redactUrl(network.rpcUrl);
  const chainId = await fetchRelayChainId(fetchImpl, network.rpcUrl, timeoutMs);
  if (chainId === null) {
    return integration("relay", "error", `The JSON-RPC relay at ${origin} did not answer eth_chainId.`, {
      remediation: `Contract reads and deployment need it. Check your connection, or ${ENV.RPC_URL}.`,
      variable: ENV.RPC_URL,
      transient: true,
      details: { origin },
    });
  }
  if (chainId !== network.chainId) {
    return integration(
      "relay",
      "error",
      `The relay at ${origin} serves chain ID ${chainId}, but ${network.name} is ${network.chainId}.`,
      {
        remediation: `Point ${ENV.RPC_URL} to a ${network.name} relay, or unset it.`,
        variable: ENV.RPC_URL,
        details: { origin, chainId },
      },
    );
  }
  return integration("relay", "ok", `Chain ID ${chainId} at ${origin}.`, { details: { origin, chainId } });
}

// ---------------------------------------------------------------------------------------------------------------------
// HCS evidence topic (#6)
// ---------------------------------------------------------------------------------------------------------------------

async function hcsHealth(
  env: EnvironmentVariables,
  network: HederaNetwork,
  options: { fetch: typeof fetch; timeoutMs: number; inspectKey: KeyInspector },
): Promise<IntegrationHealth> {
  const topicId = env[HCS_ENV.TOPIC_ID]?.trim() ?? "";
  if (!topicId) {
    return integration("hcs", "not_configured", `${HCS_ENV.TOPIC_ID} is not set.`, {
      remediation: `Run \`yarn hcs:topic\` to create the evidence topic and write ${HCS_ENV.TOPIC_ID}.`,
      variable: HCS_ENV.TOPIC_ID,
    });
  }
  if (!isValidTopicId(topicId)) {
    return integration("hcs", "error", `${HCS_ENV.TOPIC_ID} is not a valid topic id.`, {
      remediation: "Use the shard.realm.num form, e.g. 0.0.1234.",
      variable: HCS_ENV.TOPIC_ID,
    });
  }

  const rawKey = env[ENV.OPERATOR_KEY]?.trim();
  const publisherKeys = rawKey ? ((await options.inspectKey(rawKey)) ?? []) : [];
  const links = link("Topic on HashScan", hashscanTopicUrl(network, topicId));
  const checked = await verifyHcsTopic(network, topicId, {
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    publisherKeys,
  });
  const topic = checked.topic;
  const details = {
    topicId,
    ...(topic && { memo: topic.memo, submitKey: topic.submitKey?.type ?? "none" }),
  };

  if (checked.ok) {
    return integration("hcs", "ok", `Topic ${topicId} exists and the operator key is its submitKey.`, {
      links,
      details,
    });
  }
  // Without a usable operator key the submitKey cannot be compared; the topic itself is fine.
  if (checked.error.code === "TOPIC_NOT_WRITABLE" && topic?.submitKey && publisherKeys.length === 0) {
    return integration("hcs", "ok", `Topic ${topicId} exists and has a ${topic.submitKey.type} submitKey.`, {
      warnings: [`The submitKey was not compared with the operator key: ${ENV.OPERATOR_KEY} is not set or not valid.`],
      links,
      details,
    });
  }
  return integration("hcs", "error", checked.error.message, {
    remediation: checked.error.remediation,
    variable: HCS_ENV.TOPIC_ID,
    transient: checked.error.retryable,
    links,
    details,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// CredentialRegistry (#9)
// ---------------------------------------------------------------------------------------------------------------------

async function lookupContractId(
  network: HederaNetwork,
  address: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1/contracts/${address}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { contract_id?: unknown };
    return typeof body.contract_id === "string" && /^\d+\.\d+\.\d+$/.test(body.contract_id) ? body.contract_id : null;
  } catch {
    return null;
  }
}

async function registryHealth(
  env: EnvironmentVariables,
  network: HederaNetwork,
  options: { fetch: typeof fetch; timeoutMs: number },
): Promise<IntegrationHealth> {
  const variable = CREDENTIAL_AUDIT_ENV.REGISTRY_ADDRESS;
  const raw = env[variable]?.trim() ?? "";
  if (!raw) {
    return integration("registry", "not_configured", `${variable} is not set.`, {
      remediation: `Deploy CredentialRegistry (packages/hardhat/deploy/00_deploy_credential_registry.ts) and set ${variable} to its EVM address.`,
      variable,
    });
  }
  let address: string;
  try {
    address = getAddress(raw).toLowerCase();
    if (/^0x0{40}$/.test(address)) throw new Error("zero");
  } catch {
    return integration("registry", "error", `${variable} is not a valid, non-zero EVM address.`, {
      remediation: "Use the 0x… address printed by the deployment (40 hex characters).",
      variable,
    });
  }

  const [read, contractId] = await Promise.all([
    readRegistryDeployment({
      network,
      registryAddress: address,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
    }).then(
      (deployment): { deployment: RegistryDeployment } | { error: unknown } => ({ deployment }),
      (error: unknown) => ({ error }),
    ),
    lookupContractId(network, address, options.fetch, options.timeoutMs),
  ]);
  const links = link("Contract on HashScan", hashscanContractUrl(network, contractId ?? address));
  const base = { address, ...(contractId && { contractId }) };

  if ("error" in read) {
    const notRegistry = read.error instanceof RegistryReadError && read.error.reason === "not_registry";
    return integration(
      "registry",
      "error",
      notRegistry
        ? `No CredentialRegistry answers at ${address} on ${network.name}.`
        : `Could not read CredentialRegistry at ${address}: the relay at ${redactUrl(network.rpcUrl)} did not answer.`,
      {
        remediation: notRegistry
          ? `Check ${variable} and ${ENV.NETWORK}: contract addresses are per network and per deployment.`
          : `Check your connection or ${ENV.RPC_URL}, then retry.`,
        variable: notRegistry ? variable : ENV.RPC_URL,
        transient: !notRegistry,
        links,
        details: base,
      },
    );
  }

  const { deployment } = read;
  const boundTopic = `0.0.${deployment.hcsTopicNum}`;
  const details = { ...base, hcsTopic: boundTopic, paused: deployment.paused };
  const warnings = deployment.paused ? ["Issuance is paused (revocation still works)."] : [];
  const configuredTopic = env[HCS_ENV.TOPIC_ID]?.trim() ?? "";
  // The contract stores only the topic number; shard and realm are 0 on every public network.
  if (isValidTopicId(configuredTopic) && BigInt(configuredTopic.split(".")[2]) !== deployment.hcsTopicNum) {
    return integration(
      "registry",
      "error",
      `CredentialRegistry was deployed for topic ${boundTopic}, but ${HCS_ENV.TOPIC_ID} is ${configuredTopic}.`,
      {
        remediation: `Set ${HCS_ENV.TOPIC_ID} to ${boundTopic}, or redeploy CredentialRegistry for ${configuredTopic}.`,
        variable: HCS_ENV.TOPIC_ID,
        warnings,
        links,
        details,
      },
    );
  }
  return integration("registry", "ok", `Deployed at ${contractId ?? address}, bound to topic ${boundTopic}.`, {
    warnings,
    links,
    details,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Wallet account
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `not_found` is a normal state, not an error: an EVM address gets a Hedera account (and id) only when it first
 * receives HBAR.
 */
export type EvmAccountLookup =
  | { status: "found"; accountId: string; hashscanUrl: string | null }
  | { status: "not_found" }
  | { status: "invalid" }
  | { status: "unavailable" };

/** Resolves the Hedera account id of an EVM address on the selected network, through the configured Mirror Node. */
export async function lookupEvmAccount(
  env: EnvironmentVariables,
  address: string,
  options: Pick<HealthCheckOptions, "fetch" | "timeoutMs"> = {},
): Promise<EvmAccountLookup> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { status: "invalid" };
  let network: HederaNetwork;
  try {
    network = getSelectedNetwork(env);
  } catch {
    return { status: "unavailable" };
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(
      `${network.mirrorNodeUrl}/api/v1/accounts/${address.toLowerCase()}?transactions=false`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS),
      },
    );
    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) return { status: "unavailable" };
    const body = (await response.json()) as { account?: unknown };
    if (typeof body.account !== "string" || !/^\d+\.\d+\.\d+$/.test(body.account)) return { status: "unavailable" };
    return { status: "found", accountId: body.account, hashscanUrl: hashscanAccountUrl(network, body.account) };
  } catch {
    return { status: "unavailable" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------------

/** Runs every check in parallel. Never throws for a broken environment: problems are statuses in the report. */
export async function checkHederaHealth(
  env: EnvironmentVariables,
  options: HealthCheckOptions = {},
): Promise<HederaHealthReport> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const inspectKey = options.inspectKey ?? inspectPrivateKey;
  const checkedAt = now();

  let network: HederaNetwork | null;
  try {
    network = getSelectedNetwork(env);
  } catch {
    network = null;
  }

  const environmentCheck = validateHederaEnvironment(env, {
    fetch: fetchImpl,
    timeoutMs,
    now,
    inspectKey,
    requireOperatorKey: false,
  });

  let checks: Omit<Record<IntegrationId, IntegrationHealth>, "environment">;
  if (network) {
    const [mirror, relay, hcs, registry] = await Promise.all([
      mirrorHealth(
        network,
        fetchImpl,
        timeoutMs,
        checkedAt.getTime(),
        options.indexBudgetSeconds ?? DEFAULT_INDEX_BUDGET_SECONDS,
      ),
      relayHealth(network, fetchImpl, timeoutMs),
      hcsHealth(env, network, { fetch: fetchImpl, timeoutMs, inspectKey }),
      registryHealth(env, network, { fetch: fetchImpl, timeoutMs }),
    ]);
    checks = { mirror, relay, hcs, registry };
  } else {
    const skipped = (id: Exclude<IntegrationId, "environment">) =>
      integration(id, "error", `Not checked: ${ENV.NETWORK} is not a supported network.`, {
        remediation: `Set ${ENV.NETWORK} to testnet, mainnet or local.`,
        variable: ENV.NETWORK,
      });
    checks = { mirror: skipped("mirror"), relay: skipped("relay"), hcs: skipped("hcs"), registry: skipped("registry") };
  }

  const environment = await environmentCheck;
  const integrations = { environment: environmentHealth(environment), ...checks };
  const statuses = INTEGRATION_IDS.map(id => integrations[id].status);
  const overall: HealthStatus = statuses.includes("error")
    ? "error"
    : statuses.includes("not_configured")
      ? "not_configured"
      : "ok";

  return {
    network: network && {
      name: network.name,
      chainId: network.chainId,
      hashscanUrl: network.hashscanUrl,
      mirrorNodeOrigin: redactUrl(network.mirrorNodeUrl),
      rpcOrigin: redactUrl(network.rpcUrl),
    },
    environment,
    operator: operatorSummary(environment, network),
    integrations,
    overall,
    faucetUrl: network?.name === "testnet" ? FAUCET_URL : null,
    checkedAt: checkedAt.toISOString(),
  };
}

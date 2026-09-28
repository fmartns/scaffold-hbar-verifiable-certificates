/**
 * Configuration of the credential audit, read from the environment, and the factory that wires the Mirror Node client
 * and the `statusOf` reader. Needs no secret: the audit is read-only.
 */
import { getAddress } from "ethers";
import { ENV as HEDERA_ENV } from "../environment";
import type { EnvironmentVariables } from "../environment";
import { getSelectedNetwork, isNetworkName } from "../networks";
import type { HederaNetwork } from "../networks";
import { HCS_ENV, isValidTopicId } from "../hcs/config";
import { DEFAULT_POLL_TIMEOUT_MS } from "./audit";
import type { CredentialAuditContext } from "./audit";
import { createCredentialMirror } from "./mirror";
import { createCredentialStatusReader } from "./registry";

export const CREDENTIAL_AUDIT_ENV = {
  REGISTRY_ADDRESS: "HEDERA_CREDENTIAL_REGISTRY_ADDRESS",
  POLL_TIMEOUT_MS: "HEDERA_AUDIT_POLL_TIMEOUT_MS",
} as const;

const MIN_POLL_TIMEOUT_MS = 0;
const MAX_POLL_TIMEOUT_MS = 300_000;

export interface CredentialAuditConfig {
  network: HederaNetwork;
  registryAddress: string;
  topicId: string;
  pollTimeoutMs: number;
}

export interface CredentialAuditConfigIssue {
  variable: string;
  message: string;
}

export class CredentialAuditConfigError extends Error {
  readonly issues: CredentialAuditConfigIssue[];
  constructor(issues: CredentialAuditConfigIssue[]) {
    super(`Invalid credential audit configuration: ${issues.map(i => i.message).join(" ")}`);
    this.name = "CredentialAuditConfigError";
    this.issues = issues;
  }
}

/** Reads and validates the audit configuration; reports every problem at once. */
export function loadCredentialAuditConfig(env: EnvironmentVariables): CredentialAuditConfig {
  const issues: CredentialAuditConfigIssue[] = [];

  const rawNetwork = env[HEDERA_ENV.NETWORK]?.trim();
  if (rawNetwork && !isNetworkName(rawNetwork)) {
    issues.push({ variable: HEDERA_ENV.NETWORK, message: `${HEDERA_ENV.NETWORK} must be testnet, mainnet or local.` });
  }

  const topicId = env[HCS_ENV.TOPIC_ID]?.trim() ?? "";
  if (!isValidTopicId(topicId)) {
    issues.push({
      variable: HCS_ENV.TOPIC_ID,
      message: `${HCS_ENV.TOPIC_ID} must be the evidence topic id (shard.realm.num, e.g. 0.0.1234).`,
    });
  }

  let registryAddress = "";
  try {
    registryAddress = getAddress(env[CREDENTIAL_AUDIT_ENV.REGISTRY_ADDRESS]?.trim() ?? "").toLowerCase();
    if (/^0x0{40}$/.test(registryAddress)) throw new Error("zero");
  } catch {
    issues.push({
      variable: CREDENTIAL_AUDIT_ENV.REGISTRY_ADDRESS,
      message: `${CREDENTIAL_AUDIT_ENV.REGISTRY_ADDRESS} must be the EVM address of the deployed CredentialRegistry.`,
    });
  }

  let pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS;
  const rawTimeout = env[CREDENTIAL_AUDIT_ENV.POLL_TIMEOUT_MS]?.trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed < MIN_POLL_TIMEOUT_MS || parsed > MAX_POLL_TIMEOUT_MS) {
      issues.push({
        variable: CREDENTIAL_AUDIT_ENV.POLL_TIMEOUT_MS,
        message: `${CREDENTIAL_AUDIT_ENV.POLL_TIMEOUT_MS} must be an integer from ${MIN_POLL_TIMEOUT_MS} to ${MAX_POLL_TIMEOUT_MS}.`,
      });
    } else {
      pollTimeoutMs = parsed;
    }
  }

  if (issues.length > 0) throw new CredentialAuditConfigError(issues);
  return { network: getSelectedNetwork(env), registryAddress, topicId, pollTimeoutMs };
}

/** Wires the real Mirror Node client and `statusOf` reader. Tests inject their own `fetch`, clock and sleep. */
export function createCredentialAuditContext(
  config: CredentialAuditConfig,
  options: Pick<CredentialAuditContext, "now" | "sleep" | "indexBudgetSeconds" | "revocationLookbackSeconds"> & {
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
  } = {},
): CredentialAuditContext {
  const { fetch: fetchImpl, requestTimeoutMs, ...rest } = options;
  return {
    network: config.network,
    registryAddress: config.registryAddress,
    topicId: config.topicId,
    pollTimeoutMs: config.pollTimeoutMs,
    mirror: createCredentialMirror(config.network, { fetch: fetchImpl, timeoutMs: requestTimeoutMs }),
    registry: createCredentialStatusReader({
      network: config.network,
      registryAddress: config.registryAddress,
      fetch: fetchImpl,
      timeoutMs: requestTimeoutMs,
    }),
    ...rest,
  };
}

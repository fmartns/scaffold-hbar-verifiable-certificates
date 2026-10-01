/**
 * Server-side configuration of the issuer console: where credential evidence is published (HCS topic, operator) and
 * which `CredentialRegistry` it is bound to (the EIP-712 `verifyingContract`). Reuses the audit's validation of the
 * shared variables so both read the environment the same way. Never echoes a secret.
 */
import { ENV as HEDERA_ENV } from "../environment";
import type { EnvironmentVariables } from "../environment";
import { CredentialAuditConfigError, loadCredentialAuditConfig } from "../audit/config";
import { DEFAULT_PUBLISH_TIMEOUT_MS, HCS_ENV } from "../hcs/config";
import type { HederaNetwork } from "../networks";

export interface CredentialPublisherConfig {
  network: HederaNetwork;
  topicId: string;
  /** Lowercase EVM address of the `CredentialRegistry`. */
  registryAddress: string;
  timeoutMs: number;
}

export interface CredentialConfigIssue {
  variable: string;
  message: string;
}

export type CredentialPublisherConfigResult =
  { ok: true; config: CredentialPublisherConfig } | { ok: false; issues: CredentialConfigIssue[] };

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/** `requireOperator: false` for read-only uses (status), which need no operator. */
export function loadCredentialPublisherConfig(
  env: EnvironmentVariables,
  options: { requireOperator?: boolean } = {},
): CredentialPublisherConfigResult {
  const issues: CredentialConfigIssue[] = [];
  let base: Omit<CredentialPublisherConfig, "timeoutMs"> | null = null;
  try {
    const audit = loadCredentialAuditConfig(env);
    base = { network: audit.network, topicId: audit.topicId, registryAddress: audit.registryAddress };
  } catch (error) {
    if (!(error instanceof CredentialAuditConfigError)) throw error;
    issues.push(...error.issues);
  }

  for (const variable of [HEDERA_ENV.OPERATOR_ID, HEDERA_ENV.OPERATOR_KEY]) {
    if (options.requireOperator !== false && !env[variable]?.trim()) {
      issues.push({ variable, message: `${variable} is not set: the server needs the operator to publish to HCS.` });
    }
  }

  let timeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS;
  const rawTimeout = env[HCS_ENV.PUBLISH_TIMEOUT_MS]?.trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!/^\d+$/.test(rawTimeout) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
      issues.push({
        variable: HCS_ENV.PUBLISH_TIMEOUT_MS,
        message: `${HCS_ENV.PUBLISH_TIMEOUT_MS} must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`,
      });
    } else {
      timeoutMs = parsed;
    }
  }

  if (issues.length > 0 || !base) return { ok: false, issues };
  return { ok: true, config: { ...base, timeoutMs } };
}

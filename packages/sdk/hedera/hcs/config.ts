/**
 * Configuration of the HCS publisher, read from the environment. Nothing here is hardcoded: the topic and the router
 * are per deployment. The operator private key is NOT part of this configuration; only the transport ever sees it.
 */
import { ENV as HEDERA_ENV } from "../environment";
import type { EnvironmentVariables } from "../environment";
import { getSelectedNetwork, isNetworkName } from "../networks";
import type { HederaNetwork } from "../networks";
import { HcsPublishError } from "./errors";
import type { ConfigIssue } from "./errors";
import { getAddress } from "ethers";

export const HCS_ENV = {
  TOPIC_ID: "HEDERA_HCS_TOPIC_ID",
  ROUTER_ADDRESS: "HEDERA_SETTLEMENT_ROUTER_ADDRESS",
  PUBLISH_TIMEOUT_MS: "HEDERA_HCS_PUBLISH_TIMEOUT_MS",
} as const;

export const DEFAULT_PUBLISH_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

export interface HcsPublisherConfig {
  network: HederaNetwork;
  /** `shard.realm.num` of the evidence topic. */
  topicId: string;
  /** EVM address of the `SettlementRouter`: the `verifyingContract` of the signing domain. */
  routerAddress: string;
  /** Overall deadline of one publish. */
  timeoutMs: number;
}

const TOPIC_ID = /^(\d+)\.(\d+)\.(\d+)$/;

export function isValidTopicId(value: string): boolean {
  const match = TOPIC_ID.exec(value);
  return match !== null && Number(match[3]) > 0 && match.slice(1).every(part => Number.isSafeInteger(Number(part)));
}

/**
 * Reads and validates the publisher configuration. Reports every problem at once as an `HcsPublishError` with code
 * `CONFIG_INVALID`; the messages name variables and never echo secrets.
 */
export function loadHcsPublisherConfig(env: EnvironmentVariables): HcsPublisherConfig {
  const problems: ConfigIssue[] = [];

  const rawNetwork = env[HEDERA_ENV.NETWORK]?.trim();
  if (rawNetwork && !isNetworkName(rawNetwork)) {
    problems.push({
      variable: HEDERA_ENV.NETWORK,
      message: `${HEDERA_ENV.NETWORK} "${rawNetwork}" is not a supported network.`,
      remediation: "Use testnet, mainnet or local.",
    });
  }

  const topicId = env[HCS_ENV.TOPIC_ID]?.trim() ?? "";
  if (!topicId) {
    problems.push({
      variable: HCS_ENV.TOPIC_ID,
      message: `${HCS_ENV.TOPIC_ID} is not set.`,
      remediation: `Set ${HCS_ENV.TOPIC_ID}=0.0.<topic> in .env. The topic must have a submitKey equal to the operator key (ADR-001 §6.3).`,
    });
  } else if (!isValidTopicId(topicId)) {
    problems.push({
      variable: HCS_ENV.TOPIC_ID,
      message: `${HCS_ENV.TOPIC_ID} is not a valid topic id (expected shard.realm.num, e.g. 0.0.1234).`,
      remediation: "Copy the topic id from HashScan or from the TopicCreateTransaction receipt.",
    });
  }

  const router = env[HCS_ENV.ROUTER_ADDRESS]?.trim() ?? "";
  let routerAddress = "";
  if (!router) {
    problems.push({
      variable: HCS_ENV.ROUTER_ADDRESS,
      message: `${HCS_ENV.ROUTER_ADDRESS} is not set.`,
      remediation: `Set ${HCS_ENV.ROUTER_ADDRESS} to the deployed SettlementRouter EVM address. It binds every attestation (EIP-712 domain) to that deployment.`,
    });
  } else {
    try {
      routerAddress = getAddress(router).toLowerCase();
      if (/^0x0{40}$/.test(routerAddress)) throw new Error("zero");
    } catch {
      routerAddress = "";
      problems.push({
        variable: HCS_ENV.ROUTER_ADDRESS,
        message: `${HCS_ENV.ROUTER_ADDRESS} is not a valid, non-zero EVM address.`,
        remediation:
          "Use the 0x… address of the deployed SettlementRouter (40 hex characters, valid EIP-55 checksum if mixed case).",
      });
    }
  }

  let timeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS;
  const rawTimeout = env[HCS_ENV.PUBLISH_TIMEOUT_MS]?.trim();
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (!/^\d+$/.test(rawTimeout) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
      problems.push({
        variable: HCS_ENV.PUBLISH_TIMEOUT_MS,
        message: `${HCS_ENV.PUBLISH_TIMEOUT_MS} must be an integer number of milliseconds between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`,
        remediation: `Unset it to use the default (${DEFAULT_PUBLISH_TIMEOUT_MS} ms).`,
      });
    } else {
      timeoutMs = parsed;
    }
  }

  if (problems.length > 0) {
    throw new HcsPublishError({
      code: "CONFIG_INVALID",
      outcome: "not_sent",
      message: `Invalid HCS publisher configuration: ${problems.map(p => p.message).join(" ")}`,
      remediation: problems.map(p => `${p.variable}: ${p.remediation}`).join(" "),
      retryable: false,
      configIssues: problems,
    });
  }

  return { network: getSelectedNetwork(env), topicId, routerAddress, timeoutMs };
}

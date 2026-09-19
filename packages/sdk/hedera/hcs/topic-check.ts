/**
 * Startup checks of the evidence topic (ADR-001 §6.3, §8 #6): the topic must exist, must have a `submitKey` (P5) and that
 * key must be the publisher's key. Uses the Mirror Node REST API through an injectable `fetch`; no Hedera SDK, no secrets.
 * `preflightHcsPublisher` composes this with the environment validator of #5.
 */
import { validateHederaEnvironment, inspectPrivateKey, ENV as HEDERA_ENV } from "../environment";
import type { EnvironmentVariables, KeyInspector, ValidateEnvironmentOptions } from "../environment";
import type { HederaNetwork } from "../networks";
import { loadHcsPublisherConfig } from "./config";
import type { HcsPublisherConfig } from "./config";
import { HcsPublishError } from "./errors";
import type { HcsPublishFailure } from "./errors";

export interface TopicCheckOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Public keys the publisher signs with (from the operator private key). */
  publisherKeys: { type: string; publicKey: string }[];
}

export interface TopicInfo {
  topicId: string;
  /** `null` when the topic has no submit key (anyone can write: not acceptable, ADR P5). */
  submitKey: { type: string; key: string } | null;
  memo: string;
  deleted: boolean;
}

export type TopicCheckResult =
  { ok: true; topic: TopicInfo } | { ok: false; error: HcsPublishFailure; topic?: TopicInfo };

function failure(
  partial: Pick<HcsPublishFailure, "code" | "message" | "remediation"> & Partial<HcsPublishFailure>,
): HcsPublishFailure {
  return { outcome: "not_sent", retryable: false, ...partial };
}

/** Fetches the topic from Mirror Node and checks that the publisher can write to it. */
export async function verifyHcsTopic(
  network: HederaNetwork,
  topicId: string,
  options: TopicCheckOptions,
): Promise<TopicCheckResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1/topics/${topicId}`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    return {
      ok: false,
      error: failure({
        code: "NETWORK_UNAVAILABLE",
        message: "Could not reach the Mirror Node to verify the topic.",
        remediation: "Check your connection and HEDERA_MIRROR_NODE_URL, then retry. Nothing was published.",
        retryable: true,
        topicId,
      }),
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: failure({
        code: "TOPIC_INVALID",
        message: `Topic ${topicId} does not exist on ${network.name}.`,
        remediation:
          "Check HEDERA_HCS_TOPIC_ID and HEDERA_NETWORK (topic ids are per network), or create the topic. A topic created seconds ago may take a moment to appear on Mirror Node.",
        topicId,
      }),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: failure({
        code: "NETWORK_UNAVAILABLE",
        message: `The Mirror Node answered HTTP ${response.status} while verifying the topic.`,
        remediation: "Retry later.",
        retryable: true,
        topicId,
      }),
    };
  }

  const body = (await response.json()) as {
    topic_id?: string;
    memo?: string;
    deleted?: boolean;
    submit_key?: { _type?: string; key?: string } | null;
  };
  const topic: TopicInfo = {
    topicId,
    memo: body.memo ?? "",
    deleted: body.deleted === true,
    submitKey: body.submit_key?.key
      ? { type: body.submit_key._type ?? "unknown", key: body.submit_key.key.toLowerCase() }
      : null,
  };

  if (topic.deleted) {
    return {
      ok: false,
      topic,
      error: failure({
        code: "TOPIC_INVALID",
        message: `Topic ${topicId} was deleted.`,
        remediation: "Create a new topic with a submitKey and update HEDERA_HCS_TOPIC_ID.",
        topicId,
      }),
    };
  }
  if (!topic.submitKey) {
    return {
      ok: false,
      topic,
      error: failure({
        code: "TOPIC_NOT_WRITABLE",
        message: `Topic ${topicId} has no submitKey, so anyone could write to it. ADR-001 requires a submitKey (P5).`,
        remediation:
          "Create the topic with a submitKey equal to the operator key. A topic's submitKey can be added by an admin key holder.",
        topicId,
      }),
    };
  }
  const simple = topic.submitKey.type === "ED25519" || topic.submitKey.type === "ECDSA_SECP256K1";
  const matches = options.publisherKeys.some(k => k.publicKey.toLowerCase() === topic.submitKey?.key);
  if (!simple || !matches) {
    return {
      ok: false,
      topic,
      error: failure({
        code: "TOPIC_NOT_WRITABLE",
        message: simple
          ? `The operator key is not the submitKey of topic ${topicId}; the network would reject the message.`
          : `Topic ${topicId} uses a ${topic.submitKey.type} submitKey; a single operator key cannot be confirmed to satisfy it.`,
        remediation:
          "Use the publisher key as the topic's submitKey (ADR-001 §6.3), or set HEDERA_OPERATOR_KEY to the topic's submit key.",
        topicId,
      }),
    };
  }
  return { ok: true, topic };
}

export interface PreflightOptions extends Pick<ValidateEnvironmentOptions, "fetch" | "timeoutMs" | "now"> {
  inspectKey?: KeyInspector;
}

export type PreflightResult =
  { ok: true; config: HcsPublisherConfig; topic: TopicInfo } | { ok: false; error: HcsPublishFailure };

/**
 * Everything to verify before the first publish: the Hedera environment (#5: network, account, key, balance), the HCS
 * configuration and the topic. Returns a normalized failure instead of throwing.
 */
export async function preflightHcsPublisher(
  env: EnvironmentVariables,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  let config: HcsPublisherConfig;
  try {
    config = loadHcsPublisherConfig(env);
  } catch (error) {
    if (error instanceof HcsPublishError) return { ok: false, error: error.failure };
    throw error;
  }

  const environment = await validateHederaEnvironment(env, options);
  if (!environment.ok) {
    const first = environment.issues[0];
    return {
      ok: false,
      error: failure({
        code: environment.status === "unverified" ? "NETWORK_UNAVAILABLE" : "CONFIG_INVALID",
        message: `The Hedera environment is not valid: ${environment.issues.map(i => `[${i.code}] ${i.message}`).join(" ")}`,
        remediation: first ? `${first.remediation} Run \`yarn setup\` for the full report.` : "Run `yarn setup`.",
        retryable: environment.status === "unverified",
        topicId: config.topicId,
      }),
    };
  }

  const inspect = options.inspectKey ?? inspectPrivateKey;
  const candidates = (await inspect(env[HEDERA_ENV.OPERATOR_KEY] ?? "")) ?? [];
  const checked = await verifyHcsTopic(config.network, config.topicId, {
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    publisherKeys: candidates,
  });
  return checked.ok ? { ok: true, config, topic: checked.topic } : { ok: false, error: checked.error };
}

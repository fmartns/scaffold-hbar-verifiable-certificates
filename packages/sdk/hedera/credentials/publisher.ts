/**
 * Publisher of credential evidence: sends one issuance or revocation message (`credential-envelope` wire format) to the
 * HCS topic, waits for consensus and returns the receipt the registry call needs (`hcsRef`) plus what must be persisted
 * (transaction id, HashScan URL). It reuses the HCS transport, receipt interpretation and error classification of
 * `../hcs`; only the message differs from the settlement publisher. Like it, it never retries.
 */
import { hashscanTopicUrl, hashscanTransactionUrl, timestampToNanoseconds, toMirrorTransactionId } from "../explorer";
import { encodeCredentialMessage } from "../hcs/credential-envelope";
import type { CredentialMessage } from "../hcs/credential-envelope";
import type { EnvironmentVariables } from "../environment";
import { messageSha256 } from "../hcs/envelope";
import { HcsTimeoutError, classifyPublishError } from "../hcs/errors";
import type { HcsPublishFailure } from "../hcs/errors";
import { createHieroTransport, createOperatorClient } from "../hcs/hiero-transport";
import { interpretReceipt } from "../hcs/publisher";
import type { HcsTransport, TransportReceipt } from "../hcs/publisher";
import type { CredentialPublisherConfig } from "./config";
import type { CredentialPublishReceipt } from "./issuer-flow";

export type CredentialPublishResult =
  ({ ok: true } & CredentialPublishReceipt) | { ok: false; error: HcsPublishFailure };

export interface CredentialPublisher {
  readonly topicId: string;
  /** Publishes a validated message (from `buildCredentialMessage`). Never throws for publish problems. */
  publish(message: CredentialMessage): Promise<CredentialPublishResult>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HcsTimeoutError(timeoutMs)), timeoutMs);
  });
  promise.catch(() => undefined);
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function createCredentialPublisher(
  config: CredentialPublisherConfig,
  transport: HcsTransport,
  options: { now?: () => Date } = {},
): CredentialPublisher {
  const now = options.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<CredentialPublishResult>>();
  const { network, topicId } = config;

  async function run(message: CredentialMessage): Promise<CredentialPublishResult> {
    const identity = { attestationDigest: message.derived.digest };
    const bytes = encodeCredentialMessage(message);
    let transactionId: string | undefined;
    let receipt: TransportReceipt;
    try {
      receipt = await withTimeout(
        transport.submit({
          topicId,
          message: bytes,
          timeoutMs: config.timeoutMs,
          onTransactionId: id => {
            transactionId = id;
          },
        }),
        config.timeoutMs,
      );
    } catch (error) {
      return {
        ok: false,
        error: classifyPublishError(error, { topicId, transactionId, timeoutMs: config.timeoutMs, ...identity }),
      };
    }
    const interpreted = interpretReceipt(receipt);
    if (!interpreted.ok) {
      return {
        ok: false,
        error: {
          code: "UNEXPECTED_RESPONSE",
          outcome: "unknown",
          message: `The network reported success but ${interpreted.reason}.`,
          remediation: "Look the transaction up on HashScan by transactionId before deciding; it may be in the topic.",
          retryable: false,
          topicId,
          ...((receipt?.transactionId ?? transactionId) && { transactionId: receipt?.transactionId ?? transactionId }),
          ...identity,
        },
      };
    }
    return {
      ok: true,
      kind: message.kind,
      credentialId: message.derived.credentialId,
      digest: message.derived.digest,
      signer: message.derived.signer,
      topicId,
      network: network.name,
      transactionId: receipt.transactionId,
      mirrorTransactionId: toMirrorTransactionId(receipt.transactionId),
      hcsRef: {
        sequence: interpreted.sequence,
        consensusTimestampNs: timestampToNanoseconds(interpreted.consensusTimestamp),
      },
      consensusTimestamp: interpreted.consensusTimestamp,
      hashscanUrl: hashscanTransactionUrl(network, interpreted.consensusTimestamp),
      hashscanTopicUrl: hashscanTopicUrl(network, topicId),
      mirrorMessageUrl: `${network.mirrorNodeUrl}/api/v1/topics/${topicId}/messages/${interpreted.sequence}`,
      messageSha256: messageSha256(bytes),
      recordedAt: now().toISOString(),
    };
  }

  return {
    topicId,
    publish(message) {
      // The same signed message published twice concurrently is one publication.
      const key = message.derived.digest;
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pending = run(message).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}

export interface CredentialPublisherHandle {
  publisher: CredentialPublisher;
  close(): void;
}

/** Wires the Hedera SDK transport with the operator from the environment. Throws `HcsPublishError` (CONFIG_INVALID). */
export async function createCredentialPublisherFromEnv(
  env: EnvironmentVariables,
  config: CredentialPublisherConfig,
  options: { transport?: HcsTransport; fetch?: typeof fetch; now?: () => Date } = {},
): Promise<CredentialPublisherHandle> {
  if (options.transport) {
    return { publisher: createCredentialPublisher(config, options.transport, options), close: () => undefined };
  }
  const operator = await createOperatorClient(env, config.network, options.fetch);
  return {
    publisher: createCredentialPublisher(
      config,
      createHieroTransport({ client: operator.client, sdk: operator.sdk }),
      options,
    ),
    close: operator.close,
  };
}

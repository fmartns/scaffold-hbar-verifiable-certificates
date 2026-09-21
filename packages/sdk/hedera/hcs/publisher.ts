/**
 * HCS evidence publisher (issue #6).
 *
 * HCS is an evidence trail between the oracle and the `SettlementRouter`, NOT the source of truth (ADR-001 D3): being in
 * the topic does not make an event valid. This service publishes the attestation, waits for consensus and returns what a
 * caller needs to (a) persist and correlate the publication, and (b) release the attestation only after the receipt (D11).
 *
 * Responsibilities, one function each:
 *   1. build and validate the envelope   -> `buildEnvelope` (envelope.ts)
 *   2. serialize                         -> `encodeMessage` (envelope.ts)
 *   3. publish                           -> `HcsTransport.submit` (a port; the Hedera SDK adapter is hiero-transport.ts)
 *   4. handle the transaction result     -> `interpretReceipt` / `classifyPublishError`
 *   5. generate the audit metadata       -> `buildEvidence`
 *
 * The service never retries: a retry after an unknown outcome must be decided by the caller (ADR §5.5). It does not log,
 * prompt, or touch storage; it returns plain JSON-safe data.
 */
import { hashscanTopicUrl, hashscanTransactionUrl, timestampToNanoseconds, toMirrorTransactionId } from "../explorer";
import { buildEnvelope, encodeMessage, messageSha256 } from "./envelope";
import type { EnvelopeResult, Hex, HcsEnvelope, SettlementEventInput, SettlementEvent } from "./envelope";
import { HcsPublishError, HcsTimeoutError, classifyPublishError } from "./errors";
import type { HcsPublishFailure } from "./errors";
import { DEFAULT_PUBLISH_TIMEOUT_MS } from "./config";
import type { HcsPublisherConfig } from "./config";

// ---------------------------------------------------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------------------------------------------------

export interface TransportRequest {
  topicId: string;
  message: Uint8Array;
  timeoutMs: number;
  /** The transport MUST call this as soon as the transaction ID exists (before sending), so a timeout can report it. */
  onTransactionId(transactionId: string): void;
}

/** What the consensus node reports for a successful publication. Plain data: no Hedera SDK types. */
export interface TransportReceipt {
  /** SDK format: `0.0.123@1712345678.123456789`. */
  transactionId: string;
  /** From the receipt (NV-6). Decimal string. */
  sequenceNumber: string;
  /** From the receipt. Hex, with or without `0x`. */
  runningHash: string;
  /** From the transaction RECORD (NV-6), `seconds.nanoseconds` with 9 fractional digits. */
  consensusTimestamp: string;
}

/** Sends one message to one topic exactly once and reports the consensus result. It must not retry. */
export interface HcsTransport {
  submit(request: TransportRequest): Promise<TransportReceipt>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Result types (JSON-safe: strings and numbers only, so they can be persisted as they are)
// ---------------------------------------------------------------------------------------------------------------------

export interface EventIdentity {
  eventKey: Hex;
  settlementId: Hex;
  attestationDigest: Hex;
  contentHash: Hex;
  eventSource: Hex;
  externalEventId: Hex;
  /** Signer recovered from the attestation. */
  signer: Hex;
}

/** The publisher's CLAIM of where the attestation sits in HCS (`HcsRef` in ADR §6.4). Not verifiable on-chain. */
export interface HcsRefClaim {
  /** Topic sequence number, decimal string. */
  sequence: string;
  /** Consensus timestamp in nanoseconds since the epoch, decimal string (uint64 does not fit a JS number). */
  consensusTimestampNs: string;
}

export interface AuditMetadata {
  schema: "hcs-evidence/v1";
  messageFormatVersion: number;
  /** Size of the published message in bytes. */
  messageBytes: number;
  /** SHA-256 of the published message; compare with the message fetched from Mirror Node. */
  messageSha256: Hex;
  network: string;
  chainId: number;
  /** EVM address of the router the attestation is bound to. */
  routerAddress: string;
  /** Mirror Node REST URL of the published message (direct lookup by topic and sequence, ADR §5.3). */
  mirrorMessageUrl: string;
  /** Local clock at the moment the receipt was processed (ISO 8601). Informational: consensus time is authoritative. */
  recordedAt: string;
}

export interface PublishSuccess {
  ok: true;
  status: "published";
  event: EventIdentity;
  topicId: string;
  network: string;
  /** Hedera transaction ID (SDK format). PERSIST this for correlation. */
  transactionId: string;
  /** Same transaction in Mirror Node REST format (`0.0.123-1712345678-123456789`). */
  mirrorTransactionId: string;
  hcsRef: HcsRefClaim;
  /** `seconds.nanoseconds`, as Mirror Node shows it. */
  consensusTimestamp: string;
  runningHash: Hex;
  /** HashScan page of the transaction; `null` only on networks without a public explorer (local). */
  hashscanUrl: string | null;
  /** HashScan page of the topic; `null` only on networks without a public explorer (local). */
  hashscanTopicUrl: string | null;
  audit: AuditMetadata;
}

export interface PublishFailureResult {
  ok: false;
  status: "failed";
  error: HcsPublishFailure;
}

export type PublishResult = PublishSuccess | PublishFailureResult;

export interface HcsPublisher {
  readonly topicId: string;
  readonly network: string;
  /**
   * Publishes one attestation. Never throws for publish problems: it returns `{ ok: false, error }` with a normalized,
   * programmatically identifiable `error.code` and `error.outcome`. It never retries.
   */
  publish(input: PublishInput): Promise<PublishResult>;
}

export interface PublishInput {
  event: SettlementEventInput | SettlementEvent;
  /** 65-byte `r || s || v` EIP-712 signature of the event. */
  signature: string;
}

export interface CreatePublisherOptions {
  /** When set, the recovered signer must equal this address or the event is rejected before sending. */
  expectedSigner?: string;
  /** Clock, for deterministic tests. */
  now?: () => Date;
}

// ---------------------------------------------------------------------------------------------------------------------
// Links and identifiers
// ---------------------------------------------------------------------------------------------------------------------

// Explorer and Mirror identifiers live in hedera/explorer.ts (shared with the HTS adapter); re-exported for callers.
export { hashscanTopicUrl, hashscanTransactionUrl, timestampToNanoseconds, toMirrorTransactionId };

// ---------------------------------------------------------------------------------------------------------------------
// Step 4: interpret the transaction result
// ---------------------------------------------------------------------------------------------------------------------

/** Validates a receipt from the transport. A success without what the evidence needs is a failure, not a success. */
export function interpretReceipt(
  receipt: TransportReceipt,
): { ok: true; sequence: string; runningHash: Hex; consensusTimestamp: string } | { ok: false; reason: string } {
  if (!/^[1-9]\d*$/.test(receipt.sequenceNumber ?? ""))
    return { ok: false, reason: "the receipt has no valid topic sequence number" };
  const hash = (receipt.runningHash ?? "").replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hash) || hash.length % 2 !== 0)
    return { ok: false, reason: "the receipt has no valid running hash" };
  if (!/^\d+\.\d{9}$/.test(receipt.consensusTimestamp ?? ""))
    return { ok: false, reason: "the record has no valid consensus timestamp" };
  if (!/^\d+\.\d+\.\d+@\d+\.\d+$/.test(receipt.transactionId ?? ""))
    return { ok: false, reason: "the response has no valid transaction id" };
  return {
    ok: true,
    sequence: receipt.sequenceNumber,
    runningHash: `0x${hash}` as Hex,
    consensusTimestamp: receipt.consensusTimestamp,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 5: audit metadata and the persistable evidence
// ---------------------------------------------------------------------------------------------------------------------

export function buildEvidence(args: {
  envelope: HcsEnvelope;
  message: Uint8Array;
  receipt: TransportReceipt;
  sequence: string;
  runningHash: Hex;
  consensusTimestamp: string;
  config: HcsPublisherConfig;
  now: Date;
}): PublishSuccess {
  const { envelope, message, receipt, config } = args;
  const { network, topicId } = config;
  return {
    ok: true,
    status: "published",
    event: {
      eventKey: envelope.derived.eventKey,
      settlementId: envelope.derived.settlementId,
      attestationDigest: envelope.derived.attestationDigest,
      contentHash: envelope.derived.contentHash,
      eventSource: envelope.event.eventSource,
      externalEventId: envelope.event.externalEventId,
      signer: envelope.derived.signer,
    },
    topicId,
    network: network.name,
    transactionId: receipt.transactionId,
    mirrorTransactionId: toMirrorTransactionId(receipt.transactionId),
    hcsRef: { sequence: args.sequence, consensusTimestampNs: timestampToNanoseconds(args.consensusTimestamp) },
    consensusTimestamp: args.consensusTimestamp,
    runningHash: args.runningHash,
    hashscanUrl: hashscanTransactionUrl(network, args.consensusTimestamp),
    hashscanTopicUrl: hashscanTopicUrl(network, topicId),
    audit: {
      schema: "hcs-evidence/v1",
      messageFormatVersion: message[0],
      messageBytes: message.length,
      messageSha256: messageSha256(message),
      network: network.name,
      chainId: network.chainId,
      routerAddress: config.routerAddress,
      mirrorMessageUrl: `${network.mirrorNodeUrl}/api/v1/topics/${topicId}/messages/${args.sequence}`,
      recordedAt: args.now.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HcsTimeoutError(timeoutMs)), timeoutMs);
  });
  // The transport keeps running after a timeout; swallow its late rejection so it is never an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function createHcsPublisher(
  config: HcsPublisherConfig,
  transport: HcsTransport,
  options: CreatePublisherOptions = {},
): HcsPublisher {
  if (!config?.topicId || !config.routerAddress || !config.network) {
    throw new HcsPublishError({
      code: "CONFIG_INVALID",
      outcome: "not_sent",
      message: "createHcsPublisher needs a complete configuration (use loadHcsPublisherConfig).",
      remediation: "Build the configuration with loadHcsPublisherConfig(process.env).",
      retryable: false,
    });
  }
  const now = options.now ?? (() => new Date());
  const timeoutMs = config.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const domain = { chainId: config.network.chainId, verifyingContract: config.routerAddress };
  // The same attestation published twice concurrently in this process is one publication (idempotency at the door).
  const inFlight = new Map<string, Promise<PublishResult>>();

  async function run(built: EnvelopeResult<HcsEnvelope>): Promise<PublishResult> {
    // 1. build and validate the envelope (done by the caller so the digest can key the in-flight map)
    if (!built.ok) {
      return {
        ok: false,
        status: "failed",
        error: {
          code: "INVALID_EVENT",
          outcome: "not_sent",
          message: `The event or signature is invalid: ${built.issues.map(i => `${i.field}: ${i.message}`).join(" ")}`,
          remediation: "Fix the listed fields. Nothing was sent to the network.",
          retryable: false,
          topicId: config.topicId,
          issues: built.issues,
        },
      };
    }
    const envelope = built.value;
    const identity = { eventKey: envelope.derived.eventKey, attestationDigest: envelope.derived.attestationDigest };

    // 2. serialize
    const message = encodeMessage(envelope);

    // 3. publish
    let transactionId: string | undefined;
    let receipt: TransportReceipt;
    try {
      receipt = await withTimeout(
        transport.submit({
          topicId: config.topicId,
          message,
          timeoutMs,
          onTransactionId: id => {
            transactionId = id;
          },
        }),
        timeoutMs,
      );
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        error: classifyPublishError(error, { topicId: config.topicId, transactionId, timeoutMs, ...identity }),
      };
    }

    // 4. handle the transaction result
    const interpreted = interpretReceipt(receipt);
    if (!interpreted.ok) {
      return {
        ok: false,
        status: "failed",
        error: {
          code: "UNEXPECTED_RESPONSE",
          outcome: "unknown",
          message: `The network reported success but ${interpreted.reason}.`,
          remediation:
            "Look the transaction up on Mirror Node / HashScan by transactionId before deciding; the message may be in the topic.",
          retryable: false,
          topicId: config.topicId,
          ...(receipt?.transactionId || transactionId
            ? { transactionId: receipt?.transactionId ?? transactionId }
            : {}),
          ...identity,
        },
      };
    }

    // 5. audit metadata
    return buildEvidence({
      envelope,
      message,
      receipt,
      sequence: interpreted.sequence,
      runningHash: interpreted.runningHash,
      consensusTimestamp: interpreted.consensusTimestamp,
      config,
      now: now(),
    });
  }

  return {
    topicId: config.topicId,
    network: config.network.name,
    publish(input) {
      const built = buildEnvelope(input, domain, { expectedSigner: options.expectedSigner });
      const key = built.ok ? built.value.derived.attestationDigest : null;
      if (key === null) return run(built);
      const existing = inFlight.get(key);
      if (existing) return existing;
      const pending = run(built).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}

/** Turns a failed result into a thrown `HcsPublishError`, for callers that prefer exceptions. */
export function unwrapPublish(result: PublishResult): PublishSuccess {
  if (result.ok) return result;
  throw new HcsPublishError(result.error);
}

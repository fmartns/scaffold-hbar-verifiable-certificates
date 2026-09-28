/**
 * Credential audit (#10): correlates the HCS evidence of a credential's lifecycle (issuance, revocation) with the
 * `CredentialRegistry` state and logs, through the Mirror Node.
 *
 * - The authority is `statusOf` (ADR D10): the report never overrides it, it explains it.
 * - Every Mirror read that expects data polls with backoff until `pollTimeoutMs`. Data still absent is reported as
 *   `*_PENDING` while younger than `indexBudgetSeconds`, and as missing only after that budget.
 * - Expected failures (Mirror or RPC unreachable, undecodable message) are findings, never exceptions.
 */
import { hashscanTransactionUrl } from "../explorer";
import type { HederaNetwork } from "../networks";
import { decodeCredentialMessage } from "../hcs/credential-envelope";
import type { CredentialMessage } from "../hcs/credential-envelope";
import type { Hex } from "../hcs/envelope";
import { MirrorReadError } from "./mirror";
import type { ContractLog, CredentialMirror, HcsTopicMessage } from "./mirror";
import { pollUntilFound } from "./poll";
import type { PollOptions } from "./poll";
import {
  CREDENTIAL_ISSUED_TOPIC,
  CREDENTIAL_REVOKED_TOPIC,
  RegistryReadError,
  decodeCredentialIssuedLog,
  decodeCredentialRevokedLog,
} from "./registry";
import type { CredentialStatusReader, OnChainCredentialRecord } from "./registry";
import { AUDIT_FINDINGS } from "./types";
import type {
  AuditFinding,
  AuditFindingCode,
  CredentialAuditReport,
  EvidenceStatus,
  IssuanceCorrelation,
  RevocationCorrelation,
  TimelineEntry,
} from "./types";

export const DEFAULT_POLL_TIMEOUT_MS = 20_000;
/** ADR-001 §6.2: before this, data absent from the Mirror Node is "pending", not "missing". */
export const DEFAULT_INDEX_BUDGET_SECONDS = 60;
export const DEFAULT_REVOCATION_LOOKBACK_SECONDS = 3_600;
/** `block.timestamp` is block-level (ADR P7): search logs slightly around it. */
const LOG_WINDOW_BEFORE_SECONDS = 2n;
const LOG_WINDOW_AFTER_SECONDS = 15n;

export interface CredentialAuditContext {
  network: HederaNetwork;
  registryAddress: string;
  topicId: string;
  mirror: CredentialMirror;
  registry: CredentialStatusReader;
  pollTimeoutMs?: number;
  indexBudgetSeconds?: number;
  /** How far before the revocation block the topic is scanned for revocation evidence. */
  revocationLookbackSeconds?: number;
  poll?: Pick<PollOptions, "initialDelayMs" | "maxDelayMs" | "factor">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AuditCredentialOptions {
  /** Known sequence of the revocation evidence: fetched directly instead of scanning the topic. */
  revocationHcsSequence?: bigint;
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------------

const ns = (timestamp: string): bigint => {
  const [seconds, nanos = "0"] = timestamp.split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(nanos.padEnd(9, "0").slice(0, 9));
};
const secondsTs = (seconds: bigint) => `${seconds < 0n ? 0n : seconds}.000000000`;

class AuditRun {
  readonly findings: AuditFinding[] = [];
  readonly timeline: TimelineEntry[] = [];
  private highest: string | null = null;
  readonly now: () => number;
  readonly domain: { chainId: number; verifyingContract: string };

  constructor(readonly ctx: CredentialAuditContext) {
    this.now = ctx.now ?? Date.now;
    this.domain = { chainId: ctx.network.chainId, verifyingContract: ctx.registryAddress };
  }

  add(code: AuditFindingCode, message: string) {
    this.findings.push({ code, severity: AUDIT_FINDINGS[code], message });
  }

  /** Number of high/medium findings so far; used to tell whether a correlation step matched. */
  problems() {
    return this.findings.filter(f => f.severity !== "info").length;
  }

  seen(timestamp: string) {
    if (!this.highest || ns(timestamp) > ns(this.highest)) this.highest = timestamp;
  }

  get highestSeen() {
    return this.highest;
  }

  hashscan(timestamp: string) {
    return hashscanTransactionUrl(this.ctx.network, timestamp);
  }

  poll<T>(probe: () => Promise<T | null | undefined>) {
    return pollUntilFound(probe, {
      timeoutMs: this.ctx.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      now: this.now,
      sleep: this.ctx.sleep,
      ...this.ctx.poll,
    });
  }

  /** Pending while `anchorSeconds` is younger than the index budget, missing after it. */
  absent(anchorSeconds: bigint, pending: AuditFindingCode, missing: AuditFindingCode, what: string) {
    const age = BigInt(Math.floor(this.now() / 1000)) - anchorSeconds;
    const budget = BigInt(this.ctx.indexBudgetSeconds ?? DEFAULT_INDEX_BUDGET_SECONDS);
    if (age <= budget) this.add(pending, `${what} is not indexed by the Mirror Node yet (${age}s old); retry later.`);
    else this.add(missing, `${what} was not found on the Mirror Node ${age}s after the fact.`);
  }

  async findLog<T extends { credentialId: Hex }>(
    topic0: string,
    credentialId: Hex,
    anchorSeconds: bigint,
    decode: (log: ContractLog) => T | null,
  ): Promise<{ log: ContractLog; decoded: T } | null> {
    const result = await this.poll(async () => {
      const logs = await this.ctx.mirror.getContractLogs(this.ctx.registryAddress, {
        topic0,
        topic1: credentialId,
        from: secondsTs(anchorSeconds - LOG_WINDOW_BEFORE_SECONDS),
        to: secondsTs(anchorSeconds + LOG_WINDOW_AFTER_SECONDS),
      });
      for (const log of logs) {
        const decoded = decode(log);
        if (decoded && decoded.credentialId === credentialId) return { log, decoded };
      }
      return null;
    });
    if (!result.found) return null;
    this.seen(result.value.log.consensusTimestamp);
    return result.value;
  }

  async fetchMessage(sequence: bigint): Promise<HcsTopicMessage | null> {
    const result = await this.poll(() => this.ctx.mirror.getTopicMessage(this.ctx.topicId, sequence));
    if (!result.found) return null;
    this.seen(result.value.consensusTimestamp);
    return result.value;
  }

  decode(message: HcsTopicMessage): CredentialMessage | string {
    const decoded = decodeCredentialMessage(message.message, this.domain);
    return decoded.ok ? decoded.value : decoded.issues.map(i => i.message).join(" ");
  }

  hcsEvidence(message: HcsTopicMessage, decoded: CredentialMessage) {
    return {
      topicId: message.topicId,
      sequence: message.sequenceNumber,
      consensusTimestamp: message.consensusTimestamp,
      payerAccountId: message.payerAccountId,
      signer: decoded.derived.signer,
      digest: decoded.derived.digest,
      hashscanUrl: this.hashscan(message.consensusTimestamp),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Correlation steps
// ---------------------------------------------------------------------------------------------------------------------

async function correlateIssuance(
  run: AuditRun,
  credentialId: Hex,
  record: OnChainCredentialRecord,
): Promise<IssuanceCorrelation> {
  const before = run.problems();
  const found = await run.findLog(CREDENTIAL_ISSUED_TOPIC, credentialId, record.issuedAt, decodeCredentialIssuedLog);
  if (!found) {
    run.absent(record.issuedAt, "ONCHAIN_LOG_PENDING", "ONCHAIN_LOG_MISSING", "The CredentialIssued log");
    return { hcs: null, onChain: null, matched: false };
  }
  const { log, decoded: issued } = found;
  const onChain = {
    transactionHash: log.transactionHash,
    consensusTimestamp: log.consensusTimestamp,
    hashscanUrl: run.hashscan(log.consensusTimestamp),
    signer: issued.signer,
    attestationDigest: issued.attestationDigest,
    schemaId: issued.schemaId,
    hcsSequence: issued.hcsSequence,
    hcsConsensusTimestampNs: issued.hcsConsensusTimestampNs,
  };
  run.timeline.push({
    step: "chain.issued",
    consensusTimestamp: log.consensusTimestamp,
    reference: log.transactionHash,
    hashscanUrl: onChain.hashscanUrl,
  });

  const message = await run.fetchMessage(issued.hcsSequence);
  if (!message) {
    run.absent(
      ns(log.consensusTimestamp) / 1_000_000_000n,
      "HCS_PENDING_INDEX",
      "HCS_MISSING",
      `HCS message ${run.ctx.topicId}#${issued.hcsSequence} (claimed by the issuance)`,
    );
    return { hcs: null, onChain, matched: false };
  }
  const decoded = run.decode(message);
  if (typeof decoded === "string") {
    run.add("HCS_UNDECODABLE", `HCS message #${message.sequenceNumber} is not a valid credential message: ${decoded}`);
    return { hcs: null, onChain, matched: false };
  }
  const hcs = run.hcsEvidence(message, decoded);
  run.timeline.push({
    step: "hcs.issuance",
    consensusTimestamp: message.consensusTimestamp,
    reference: `${message.topicId}#${message.sequenceNumber}`,
    hashscanUrl: hcs.hashscanUrl,
  });

  if (decoded.kind !== "issuance" || decoded.derived.credentialId !== credentialId) {
    run.add(
      "HCS_REF_MISMATCH",
      `HCS message #${message.sequenceNumber} is a ${decoded.kind} of ${decoded.derived.credentialId}, not the issuance of ${credentialId}.`,
    );
  } else {
    if (decoded.derived.digest !== issued.attestationDigest) {
      run.add("HCS_DIGEST_MISMATCH", "The HCS attestation digest differs from the one emitted on-chain.");
    }
    if (decoded.derived.signer !== issued.signer || decoded.derived.signer !== record.signer) {
      run.add("HCS_SIGNER_MISMATCH", `The HCS issuance is signed by ${decoded.derived.signer}, not ${record.signer}.`);
    }
    if (
      decoded.event.credentialHash !== record.credentialHash ||
      decoded.event.subjectCommitment !== record.subjectCommitment ||
      decoded.event.issuer !== record.issuer
    ) {
      run.add("HCS_CONTENT_MISMATCH", "The HCS issuance content differs from the on-chain record.");
    }
  }
  if (ns(message.consensusTimestamp) !== issued.hcsConsensusTimestampNs) {
    run.add(
      "HCS_REF_MISMATCH",
      `The on-chain HCS consensus timestamp claim (${issued.hcsConsensusTimestampNs}) differs from the message's (${ns(message.consensusTimestamp)}).`,
    );
  }
  if (ns(message.consensusTimestamp) >= ns(log.consensusTimestamp)) {
    run.add("HCS_AFTER_ONCHAIN", "The HCS evidence reached consensus after the issuance transaction.");
  }
  return { hcs, onChain, matched: run.problems() === before };
}

async function correlateRevocation(
  run: AuditRun,
  credentialId: Hex,
  record: OnChainCredentialRecord,
  knownSequence: bigint | undefined,
): Promise<RevocationCorrelation> {
  const before = run.problems();
  const found = await run.findLog(CREDENTIAL_REVOKED_TOPIC, credentialId, record.revokedAt, decodeCredentialRevokedLog);
  let onChain: RevocationCorrelation["onChain"] = null;
  if (found) {
    onChain = {
      transactionHash: found.log.transactionHash,
      consensusTimestamp: found.log.consensusTimestamp,
      hashscanUrl: run.hashscan(found.log.consensusTimestamp),
      revokedBy: found.decoded.revokedBy,
      byAdmin: found.decoded.byAdmin,
    };
    run.timeline.push({
      step: "chain.revoked",
      consensusTimestamp: onChain.consensusTimestamp,
      reference: onChain.transactionHash,
      hashscanUrl: onChain.hashscanUrl,
    });
  } else {
    run.absent(record.revokedAt, "ONCHAIN_LOG_PENDING", "ONCHAIN_LOG_MISSING", "The CredentialRevoked log");
  }

  let candidates: { message: HcsTopicMessage; decoded: Extract<CredentialMessage, { kind: "revocation" }> }[] = [];
  if (knownSequence !== undefined) {
    const message = await run.fetchMessage(knownSequence);
    if (!message) {
      run.add(
        "HCS_NOT_FOUND",
        `HCS message ${run.ctx.topicId}#${knownSequence} was not found within the poll timeout.`,
      );
    } else {
      const decoded = run.decode(message);
      if (typeof decoded === "string") {
        run.add("HCS_UNDECODABLE", `HCS message #${knownSequence} is not a valid credential message: ${decoded}`);
      } else if (decoded.kind !== "revocation" || decoded.derived.credentialId !== credentialId) {
        run.add("HCS_REF_MISMATCH", `HCS message #${knownSequence} is not a revocation of ${credentialId}.`);
      } else {
        candidates = [{ message, decoded }];
      }
    }
  } else {
    const budget = BigInt(run.ctx.indexBudgetSeconds ?? DEFAULT_INDEX_BUDGET_SECONDS);
    const lookback = BigInt(run.ctx.revocationLookbackSeconds ?? DEFAULT_REVOCATION_LOOKBACK_SECONDS);
    const result = await run.poll(async () => {
      const messages = await run.ctx.mirror.listTopicMessages(run.ctx.topicId, {
        from: secondsTs(record.revokedAt - lookback),
        to: secondsTs(record.revokedAt + LOG_WINDOW_AFTER_SECONDS + budget),
      });
      // Messages that are not credential revocations (other kinds, noise on the topic) are ignored (ADR SC-20).
      const matches = messages.flatMap(message => {
        const decoded = run.decode(message);
        return typeof decoded !== "string" &&
          decoded.kind === "revocation" &&
          decoded.derived.credentialId === credentialId
          ? [{ message, decoded }]
          : [];
      });
      return matches.length > 0 ? matches : null;
    });
    if (result.found) candidates = result.value;
    else {
      run.absent(
        record.revokedAt,
        "REVOCATION_EVIDENCE_PENDING",
        "REVOCATION_EVIDENCE_MISSING",
        "HCS revocation evidence",
      );
    }
  }
  if (candidates.length === 0) return { hcs: null, onChain, matched: false };

  const revokedBy = onChain?.revokedBy;
  const chosen = candidates.find(c => c.decoded.derived.signer === revokedBy) ?? candidates[candidates.length - 1];
  run.seen(chosen.message.consensusTimestamp);
  const hcs = { ...run.hcsEvidence(chosen.message, chosen.decoded), reasonCode: chosen.decoded.revocation.reasonCode };
  run.timeline.push({
    step: "hcs.revocation",
    consensusTimestamp: hcs.consensusTimestamp,
    reference: `${hcs.topicId}#${hcs.sequence}`,
    hashscanUrl: hcs.hashscanUrl,
  });
  if (chosen.decoded.revocation.issuer !== record.issuer) {
    run.add("HCS_CONTENT_MISMATCH", "The HCS revocation names a different issuer than the on-chain record.");
  }
  if (onChain) {
    if (hcs.signer !== onChain.revokedBy) {
      run.add(
        "REVOCATION_SIGNER_MISMATCH",
        `The HCS revocation is signed by ${hcs.signer}, the on-chain revocation was sent by ${onChain.revokedBy}.`,
      );
    }
    if (ns(hcs.consensusTimestamp) >= ns(onChain.consensusTimestamp)) {
      run.add(
        "REVOCATION_AFTER_ONCHAIN",
        "The HCS revocation evidence reached consensus after the revocation transaction.",
      );
    }
  }
  return { hcs, onChain, matched: onChain !== null && run.problems() === before };
}

// ---------------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------------

interface PartialReport {
  credentialId: Hex | null;
  subject: CredentialAuditReport["subject"];
  onChain: CredentialAuditReport["onChain"];
  issuance: IssuanceCorrelation | null;
  revocation: RevocationCorrelation | null;
}

function evidenceOf(run: AuditRun, onChainStatus: CredentialAuditReport["onChain"]["status"]): EvidenceStatus {
  const codes = run.findings.map(f => f.code);
  if (codes.includes("MIRROR_UNAVAILABLE") || codes.includes("REGISTRY_UNAVAILABLE")) return "unavailable";
  if (run.findings.some(f => f.severity !== "info")) return "inconsistent";
  if (codes.some(c => c.endsWith("_PENDING") || c === "HCS_PENDING_INDEX")) return "pending_index";
  return onChainStatus === "not_found" ? "not_applicable" : "consistent";
}

function finalize(run: AuditRun, partial: PartialReport, queriedAt: string): CredentialAuditReport {
  return {
    ...partial,
    evidence: evidenceOf(run, partial.onChain.status),
    timeline: [...run.timeline].sort((a, b) => (ns(a.consensusTimestamp) < ns(b.consensusTimestamp) ? -1 : 1)),
    findings: run.findings,
    provenance: {
      network: run.ctx.network.name,
      mirrorNode: run.ctx.mirror.origin,
      rpc: run.ctx.registry.origin,
      registryAddress: run.ctx.registryAddress.toLowerCase(),
      topicId: run.ctx.topicId,
      queriedAt,
      highestConsensusTimestampSeen: run.highestSeen,
    },
  };
}

async function audit(
  run: AuditRun,
  credentialId: Hex,
  subject: CredentialAuditReport["subject"],
  options: AuditCredentialOptions,
): Promise<PartialReport> {
  const partial: PartialReport = {
    credentialId,
    subject,
    onChain: { status: "unknown", record: null },
    issuance: null,
    revocation: null,
  };
  let record: OnChainCredentialRecord;
  try {
    record = await run.ctx.registry.statusOf(credentialId);
  } catch (error) {
    if (!(error instanceof RegistryReadError)) throw error;
    run.add("REGISTRY_UNAVAILABLE", error.message);
    return partial;
  }
  partial.onChain = { status: record.status, record };
  if (record.status === "not_found") return partial;
  try {
    partial.issuance = await correlateIssuance(run, credentialId, record);
    if (record.status === "revoked") {
      partial.revocation = await correlateRevocation(run, credentialId, record, options.revocationHcsSequence);
    }
  } catch (error) {
    if (!(error instanceof MirrorReadError)) throw error;
    run.add("MIRROR_UNAVAILABLE", error.message);
  }
  return partial;
}

/**
 * Audits one credential: reads `statusOf`, then correlates the `CredentialIssued` log with the HCS message it claims,
 * and, if revoked, the `CredentialRevoked` log with the HCS revocation evidence.
 */
export async function auditCredential(
  credentialId: string,
  ctx: CredentialAuditContext,
  options: AuditCredentialOptions = {},
): Promise<CredentialAuditReport> {
  const run = new AuditRun(ctx);
  const queriedAt = new Date(run.now()).toISOString();
  const partial = await audit(run, credentialId.toLowerCase() as Hex, { kind: "credential" }, options);
  return finalize(run, partial, queriedAt);
}

/**
 * Audits starting from one HCS message: decodes it, then audits its credential and reports how this specific message
 * relates to the on-chain record (the referenced evidence, a benign duplicate, an equivocation, or not on-chain yet).
 */
export async function auditHcsMessage(sequence: bigint, ctx: CredentialAuditContext): Promise<CredentialAuditReport> {
  const run = new AuditRun(ctx);
  const queriedAt = new Date(run.now()).toISOString();
  const subject = { kind: "hcs" as const, topicId: ctx.topicId, sequence };
  const empty: PartialReport = {
    credentialId: null,
    subject,
    onChain: { status: "unknown", record: null },
    issuance: null,
    revocation: null,
  };

  let message: HcsTopicMessage | null;
  try {
    message = await run.fetchMessage(sequence);
  } catch (error) {
    if (!(error instanceof MirrorReadError)) throw error;
    run.add("MIRROR_UNAVAILABLE", error.message);
    return finalize(run, empty, queriedAt);
  }
  if (!message) {
    run.add("HCS_NOT_FOUND", `HCS message ${ctx.topicId}#${sequence} was not found within the poll timeout.`);
    return finalize(run, empty, queriedAt);
  }
  const decoded = run.decode(message);
  if (typeof decoded === "string") {
    run.add("HCS_UNDECODABLE", `HCS message #${sequence} is not a valid credential message: ${decoded}`);
    return finalize(run, empty, queriedAt);
  }

  const credentialId = decoded.derived.credentialId;
  const partial = await audit(
    run,
    credentialId,
    subject,
    decoded.kind === "revocation" ? { revocationHcsSequence: sequence } : {},
  );
  const status = partial.onChain.status;
  if (status === "not_found") {
    run.add("HCS_NOT_ONCHAIN", `The ${decoded.kind} in HCS message #${sequence} is not registered on-chain.`);
  } else if (decoded.kind === "revocation" && status === "issued") {
    run.add("REVOCATION_NOT_EXECUTED", `HCS message #${sequence} revokes a credential that is still issued on-chain.`);
  } else if (decoded.kind === "issuance" && partial.onChain.record && partial.issuance?.onChain) {
    if (partial.issuance.onChain.hcsSequence !== sequence) {
      const record = partial.onChain.record;
      const sameContent =
        decoded.event.credentialHash === record.credentialHash &&
        decoded.event.subjectCommitment === record.subjectCommitment;
      if (sameContent) {
        run.add(
          "HCS_DUPLICATE_BENIGN",
          `HCS message #${sequence} repeats the issuance recorded with #${partial.issuance.onChain.hcsSequence}.`,
        );
      } else if (decoded.derived.signer === record.signer) {
        run.add(
          "HCS_EQUIVOCATION",
          `HCS message #${sequence} is a validly signed issuance with different content from the on-chain record.`,
        );
      } else {
        run.add("HCS_SIGNER_MISMATCH", `HCS message #${sequence} is not signed by the issuer's recorded signer.`);
      }
    }
  }
  return finalize(run, partial, queriedAt);
}

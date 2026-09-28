/**
 * The single report type of the credential audit (#10). The public verifier (#40), the issuer console (#12) and the
 * testnet validation (#18) all consume it; none of them re-derive correlation rules.
 */
import type { Hex } from "../hcs/envelope";
import type { OnChainCredentialRecord } from "./registry";

export type AuditSeverity = "high" | "medium" | "info";

export const AUDIT_FINDINGS = {
  /** `statusOf` says issued/revoked, the matching log is not indexed yet (inside the index budget). */
  ONCHAIN_LOG_PENDING: "info",
  /** `statusOf` says issued/revoked, the matching log is still absent after the index budget. */
  ONCHAIN_LOG_MISSING: "high",
  HCS_PENDING_INDEX: "info",
  /** The HCS message referenced by the on-chain `hcsSequence` is still absent after the index budget. */
  HCS_MISSING: "high",
  /** A specific sequence requested by the caller was not found within the poll timeout. */
  HCS_NOT_FOUND: "medium",
  HCS_UNDECODABLE: "high",
  /** The message or its consensus timestamp does not match the on-chain claim. */
  HCS_REF_MISMATCH: "medium",
  HCS_DIGEST_MISMATCH: "high",
  HCS_SIGNER_MISMATCH: "high",
  /** HCS content (hash, subject or issuer) differs from the on-chain record. */
  HCS_CONTENT_MISMATCH: "high",
  /** Commit-before-execute violated: the HCS consensus timestamp is not earlier than the transaction. */
  HCS_AFTER_ONCHAIN: "high",
  /** Another valid message for the same credential and content (publish retry or re-signature). */
  HCS_DUPLICATE_BENIGN: "info",
  /** Another validly signed message for the same credential with different content. */
  HCS_EQUIVOCATION: "high",
  /** Valid HCS evidence whose credential is not registered on-chain (yet). */
  HCS_NOT_ONCHAIN: "info",
  REVOCATION_EVIDENCE_PENDING: "info",
  /** Revoked on-chain, but no HCS revocation evidence was found in the scanned window. */
  REVOCATION_EVIDENCE_MISSING: "medium",
  /** The HCS revocation is signed by someone other than the on-chain `revokedBy`. */
  REVOCATION_SIGNER_MISMATCH: "high",
  REVOCATION_AFTER_ONCHAIN: "medium",
  /** HCS revocation evidence exists, the credential is still issued on-chain. */
  REVOCATION_NOT_EXECUTED: "info",
  MIRROR_UNAVAILABLE: "info",
  REGISTRY_UNAVAILABLE: "info",
} as const satisfies Record<string, AuditSeverity>;

export type AuditFindingCode = keyof typeof AUDIT_FINDINGS;

export interface AuditFinding {
  code: AuditFindingCode;
  severity: AuditSeverity;
  message: string;
}

/**
 * `consistent`: every piece of evidence found and matching. `pending_index`: something is not indexed yet, inside the
 * budget; retry later. `inconsistent`: at least one high/medium finding. `unavailable`: the Mirror Node or the registry
 * could not be read. `not_applicable`: the credential was never issued, there is nothing to correlate.
 */
export type EvidenceStatus = "consistent" | "pending_index" | "inconsistent" | "unavailable" | "not_applicable";

export type TimelineStep = "hcs.issuance" | "chain.issued" | "hcs.revocation" | "chain.revoked";

export interface TimelineEntry {
  step: TimelineStep;
  consensusTimestamp: string;
  /** `topicId#sequence` for HCS, the transaction hash for the contract. */
  reference: string;
  hashscanUrl: string | null;
}

export interface HcsEvidence {
  topicId: string;
  sequence: bigint;
  consensusTimestamp: string;
  payerAccountId: string;
  signer: Hex;
  digest: Hex;
  hashscanUrl: string | null;
}

export interface OnChainEvent {
  transactionHash: string;
  consensusTimestamp: string;
  hashscanUrl: string | null;
}

export interface IssuanceCorrelation {
  hcs: HcsEvidence | null;
  onChain:
    | (OnChainEvent & {
        signer: Hex;
        attestationDigest: Hex;
        schemaId: Hex;
        hcsSequence: bigint;
        hcsConsensusTimestampNs: bigint;
      })
    | null;
  /** Both sides found and every check passed. */
  matched: boolean;
}

export interface RevocationCorrelation {
  hcs: (HcsEvidence & { reasonCode: Hex }) | null;
  onChain: (OnChainEvent & { revokedBy: Hex; byAdmin: boolean }) | null;
  matched: boolean;
}

export interface CredentialAuditReport {
  /** `null` only when an HCS message was audited and could not be decoded. */
  credentialId: Hex | null;
  /** What was audited: a credential id, or a specific HCS message. */
  subject: { kind: "credential" } | { kind: "hcs"; topicId: string; sequence: bigint };
  /** Authoritative state (`CredentialRegistry.statusOf`). The audit never overrides it. `unknown` if unreadable. */
  onChain: { status: OnChainCredentialRecord["status"] | "unknown"; record: OnChainCredentialRecord | null };
  evidence: EvidenceStatus;
  issuance: IssuanceCorrelation | null;
  revocation: RevocationCorrelation | null;
  /** Ascending by consensus timestamp. */
  timeline: TimelineEntry[];
  findings: AuditFinding[];
  provenance: {
    network: string;
    mirrorNode: string;
    rpc: string;
    registryAddress: string;
    topicId: string;
    queriedAt: string;
    /** Highest consensus timestamp observed in any Mirror answer used by this report. */
    highestConsensusTimestampSeen: string | null;
  };
}

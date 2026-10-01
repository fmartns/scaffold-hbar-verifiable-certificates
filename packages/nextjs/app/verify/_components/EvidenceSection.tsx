"use client";

import { AuditPanel } from "../../issuer/_components/AuditPanel";
import type { AuditFetcher } from "../../issuer/_components/AuditPanel";
import styles from "../verify.module.css";

/**
 * Answers "what is the matching Hedera evidence?" by reusing the issuer console's audit panel as-is: the shared
 * audit (#10) correlates `CredentialRegistry`'s logs with the HCS attestation, through the Mirror Node. Nothing
 * about Mirror polling, HashScan links or evidence correlation is re-implemented here — this component only frames
 * it for a public, non-technical reader.
 */
export function EvidenceSection({ credentialId, fetchAudit }: { credentialId: string; fetchAudit: AuditFetcher }) {
  return (
    <div>
      <p className={styles.muted}>
        The contract state above is the authority. This section shows the independent evidence trail on the Hedera
        Consensus Service (HCS) and Mirror Node that backs it up, with links to HashScan.
      </p>
      <AuditPanel credentialId={credentialId} fetchAudit={fetchAudit} />
    </div>
  );
}

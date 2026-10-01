"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { classifyIssuerError } from "@sh/sdk/hedera/wallet";
import type { CredentialAuditReportJson, IssuerError } from "@sh/sdk/hedera/wallet";
import styles from "../issuer.module.css";
import { ErrorCallout } from "./ErrorCallout";

export type AuditFetcher = (
  credentialId: string,
  options?: { revocationSequence?: string },
) => Promise<CredentialAuditReportJson>;

const STATUS_TONE: Record<string, string> = { issued: "ok", revoked: "warn", not_found: "idle", unknown: "error" };
const EVIDENCE: Record<CredentialAuditReportJson["evidence"], { tone: string; text: string }> = {
  consistent: { tone: "ok", text: "Evidence consistent" },
  pending_index: { tone: "idle", text: "Waiting for Mirror Node indexing" },
  inconsistent: { tone: "error", text: "Evidence inconsistent" },
  unavailable: { tone: "warn", text: "Mirror Node or relay unavailable" },
  not_applicable: { tone: "idle", text: "Nothing to correlate" },
};
const STEP_LABEL: Record<string, string> = {
  "hcs.issuance": "HCS issuance evidence",
  "chain.issued": "CredentialIssued event",
  "hcs.revocation": "HCS revocation evidence",
  "chain.revoked": "CredentialRevoked event",
};

const Link = ({ url, children }: { url: string | null; children: ReactNode }) =>
  url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  ) : (
    <>{children}</>
  );

/**
 * Contract events and Mirror Node evidence of one credential, from the shared audit (#10). The on-chain status is the
 * authority; while the Mirror Node has not indexed recent facts the report says `pending_index` and the panel asks again.
 */
export function AuditPanel({
  credentialId,
  revocationSequence,
  fetchAudit,
  refreshKey = 0,
  retryDelayMs = 5_000,
  maxRetries = 12,
}: {
  credentialId: string;
  revocationSequence?: string;
  fetchAudit: AuditFetcher;
  /** Changes when the credential changed (e.g. just revoked), to re-run the audit. */
  refreshKey?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}) {
  const [report, setReport] = useState<CredentialAuditReportJson | null>(null);
  const [error, setError] = useState<IssuerError | null>(null);
  const [loading, setLoading] = useState(false);
  const attempts = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    setLoading(true);
    setError(null);
    try {
      const next = await fetchAudit(credentialId, { revocationSequence });
      setReport(next);
      if (next.evidence === "pending_index" && attempts.current < maxRetries) {
        attempts.current += 1;
        timer.current = setTimeout(() => void load(), retryDelayMs);
      }
    } catch (e) {
      setError(classifyIssuerError(e));
    } finally {
      setLoading(false);
    }
  }, [credentialId, revocationSequence, fetchAudit, maxRetries, retryDelayMs]);

  useEffect(() => {
    attempts.current = 0;
    setReport(null);
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, refreshKey]);

  const issuedOnChain = report?.issuance?.onChain;
  const revokedOnChain = report?.revocation?.onChain;

  return (
    <section className={styles.card} aria-labelledby="audit-title">
      <h2 id="audit-title">
        Events and Mirror Node evidence
        <button type="button" className={styles.button} onClick={() => void load()} disabled={loading}>
          {loading ? "Auditing…" : "Refresh"}
        </button>
      </h2>
      <p className={styles.muted}>
        Credential <code>{credentialId}</code>
      </p>

      {error && <ErrorCallout error={error} />}
      {!report && !error && <p className={styles.muted}>Auditing contract logs and HCS messages…</p>}

      {report && (
        <>
          <p className={styles.badges}>
            <span className={`${styles.badge} ${styles[STATUS_TONE[report.onChain.status] ?? "idle"]}`}>
              On-chain: {report.onChain.status}
            </span>
            <span className={`${styles.badge} ${styles[EVIDENCE[report.evidence].tone]}`}>
              {EVIDENCE[report.evidence].text}
            </span>
          </p>

          <h3 className={styles.subheading}>Contract events</h3>
          {!issuedOnChain && !revokedOnChain ? (
            <p className={styles.muted}>No CredentialRegistry event indexed yet.</p>
          ) : (
            <dl className={styles.facts}>
              {issuedOnChain && (
                <>
                  <dt>CredentialIssued</dt>
                  <dd>
                    <Link url={issuedOnChain.hashscanUrl}>{issuedOnChain.consensusTimestamp}</Link> · signer{" "}
                    <code>{issuedOnChain.signer}</code> · HCS sequence {issuedOnChain.hcsSequence}
                  </dd>
                </>
              )}
              {revokedOnChain && (
                <>
                  <dt>CredentialRevoked</dt>
                  <dd>
                    <Link url={revokedOnChain.hashscanUrl}>{revokedOnChain.consensusTimestamp}</Link> · by{" "}
                    <code>{revokedOnChain.revokedBy}</code>
                    {revokedOnChain.byAdmin ? " (admin)" : ""}
                  </dd>
                </>
              )}
            </dl>
          )}

          <h3 className={styles.subheading}>Timeline</h3>
          {report.timeline.length === 0 ? (
            <p className={styles.muted}>Nothing indexed yet.</p>
          ) : (
            <ol className={styles.timeline}>
              {report.timeline.map(entry => (
                <li key={`${entry.step}-${entry.reference}`}>
                  <strong>{STEP_LABEL[entry.step] ?? entry.step}</strong> ·{" "}
                  <Link url={entry.hashscanUrl}>{entry.consensusTimestamp}</Link> · <code>{entry.reference}</code>
                </li>
              ))}
            </ol>
          )}

          {report.findings.length > 0 && (
            <>
              <h3 className={styles.subheading}>Findings</h3>
              <ul className={styles.findings}>
                {report.findings.map(f => (
                  <li key={`${f.code}-${f.message}`} data-severity={f.severity}>
                    <code>{f.code}</code> ({f.severity}): {f.message}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className={styles.meta}>
            Mirror Node <code>{report.provenance.mirrorNode}</code> · relay <code>{report.provenance.rpc}</code> ·
            queried {report.provenance.queriedAt}. HCS is evidence, not validity: the contract state decides.
          </p>
        </>
      )}
    </section>
  );
}

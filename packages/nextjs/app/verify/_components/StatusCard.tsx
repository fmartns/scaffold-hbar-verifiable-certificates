import type { CredentialStatusView, IssuerError } from "@sh/sdk/hedera/wallet";
import { ErrorCallout } from "../../issuer/_components/ErrorCallout";
import styles from "../verify.module.css";

const STATUS_BADGE: Record<CredentialStatusView["status"], { tone: string; text: string }> = {
  issued: { tone: "ok", text: "Active" },
  revoked: { tone: "warn", text: "Revoked" },
  not_found: { tone: "idle", text: "Not found" },
};

function formatUnixSeconds(value: string): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  return `${new Date(seconds * 1000)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC")}`;
}

/**
 * Answers the first four of the six core questions directly from `CredentialRegistry.statusOf` (handed over by
 * `GET /api/credentials/status`, never re-derived here): does this credential exist, who issued it (its issuer
 * identifier — the chain only ever sees `keccak256` of the organization name, never its PII), when was it issued,
 * and is it still valid or was it revoked (with the revocation date when it was).
 */
export function StatusCard({
  credentialId,
  view,
  error,
  loading,
}: {
  credentialId: string;
  view: CredentialStatusView | null;
  error: IssuerError | null;
  loading: boolean;
}) {
  return (
    <section className={styles.card} aria-labelledby="status-title">
      <h2 id="status-title">Credential status</h2>
      <p className={styles.meta}>
        Credential id <code>{credentialId}</code>
      </p>

      {loading && !view && !error && <p className={styles.muted}>Checking CredentialRegistry…</p>}
      {error && <ErrorCallout error={error} />}

      {view && (
        <>
          <p className={styles.badges}>
            <span className={`${styles.badge} ${styles[STATUS_BADGE[view.status].tone]}`}>
              {STATUS_BADGE[view.status].text}
            </span>
          </p>

          {view.status === "not_found" ? (
            <p>
              No record of this credential id exists on <code>CredentialRegistry</code>. Either it was never issued, it
              was issued on a different network, or the id is wrong — double-check it with whoever gave it to you.
            </p>
          ) : (
            <dl className={styles.questionList}>
              <div className={styles.question}>
                <dt>Does this credential exist?</dt>
                <dd>Yes — it is recorded on CredentialRegistry.</dd>
              </div>
              <div className={styles.question}>
                <dt>Who issued it?</dt>
                <dd>
                  Issuer identifier <code>{view.issuer}</code>
                  <br />
                  <span className={styles.muted}>
                    This is <code>keccak256</code> of the issuer&apos;s registered namespace, not its name — the chain
                    never stores the organization&apos;s name as plain text.
                  </span>
                </dd>
              </div>
              <div className={styles.question}>
                <dt>When was it issued?</dt>
                <dd>{formatUnixSeconds(view.issuedAt)}</dd>
              </div>
              <div className={styles.question}>
                <dt>Is it still valid, or was it revoked?</dt>
                <dd>
                  {view.status === "issued" ? (
                    "Valid — it has not been revoked."
                  ) : (
                    <>
                      Revoked on <strong>{formatUnixSeconds(view.revokedAt)}</strong>. Treat this credential as no
                      longer valid, regardless of what the document itself says.
                    </>
                  )}
                </dd>
              </div>
            </dl>
          )}
        </>
      )}
    </section>
  );
}

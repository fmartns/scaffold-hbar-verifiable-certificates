"use client";

import type { IssuanceOutcome } from "@sh/sdk/hedera/wallet";
import styles from "../issuer.module.css";
import { CopyButton } from "./CopyButton";
import { QrCode } from "./QrCode";

/** Saves the holder's credential document locally; it is built in memory and never sent or stored by the console. */
function downloadDocument(outcome: IssuanceOutcome) {
  const json = JSON.stringify(
    outcome.document,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `credential-${outcome.credentialId.slice(2, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * End of a successful issuance: the credential ID as text and QR code, the HashScan evidence, the relayer pin and what
 * the holder needs (salt and document).
 */
export function IssuanceResult({ outcome }: { outcome: IssuanceOutcome }) {
  const { credentialId, hcs, registration, subjectSalt, event } = outcome;
  return (
    <div className={styles.result} role="status" aria-label="Issuance result">
      <div className={styles.resultBody}>
        <h3>Credential issued</h3>
        <dl className={styles.facts}>
          <dt>Credential ID</dt>
          <dd>
            <code data-testid="credential-id">{credentialId}</code> <CopyButton value={credentialId} />
          </dd>
          <dt>HCS evidence</dt>
          <dd>
            {hcs.hashscanUrl ? (
              <a href={hcs.hashscanUrl} target="_blank" rel="noreferrer">
                View on HashScan ↗
              </a>
            ) : (
              <span className={styles.muted}>no public explorer on this network</span>
            )}{" "}
            <span className={styles.muted}>
              (topic {hcs.topicId}, sequence {hcs.hcsRef.sequence}, transaction <code>{hcs.transactionId}</code>)
            </span>
          </dd>
          <dt>Registry transaction</dt>
          <dd>
            <code>{registration.transactionHash}</code>
          </dd>
          <dt>Submitter</dt>
          <dd>
            <code data-testid="submitter">{event.submitter}</code>
            <span className={styles.hint}>
              Only this account could submit the signed issuance, so nobody could front-run it with forged HCS evidence.
            </span>
          </dd>
          <dt>Holder secret</dt>
          <dd>
            <code>{subjectSalt}</code> <CopyButton value={subjectSalt} />
            <span className={styles.hint}>
              Give it to the holder with the credential: it proves the holder identifier against the on-chain
              commitment. It is shown once and never stored.
            </span>
          </dd>
          <dt>Holder document</dt>
          <dd>
            <button type="button" className={styles.linkButton} onClick={() => downloadDocument(outcome)}>
              Download credential document (JSON)
            </button>
            <span className={styles.hint}>
              Contains the holder identifier, the salt and the claims, so any verifier can recompute every identifier.
              Send it only to the holder.
            </span>
          </dd>
        </dl>
      </div>
      <QrCode value={credentialId} label={`QR code of credential ID ${credentialId}`} />
    </div>
  );
}

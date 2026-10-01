import type { IssuerError } from "@sh/sdk/hedera/wallet";
import styles from "../issuer.module.css";

/** One failure, as the SDK classified it: what happened, how to fix it, and the ids to reconcile with. */
export function ErrorCallout({ error, hashscanUrl }: { error: IssuerError; hashscanUrl?: string | null }) {
  return (
    <div role="alert" className={styles.alert} data-category={error.category}>
      <strong>{error.title}</strong>
      <p>{error.message}</p>
      <p className={styles.fix}>
        <strong>Fix:</strong> {error.remediation}
      </p>
      {error.issues && error.issues.length > 0 && (
        <ul className={styles.issueList}>
          {error.issues.map(issue => (
            <li key={`${issue.field}-${issue.message}`}>
              <code>{issue.field}</code>: {issue.message}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.meta}>
        <code>{error.category}</code> · <code>{error.code}</code>
        {error.hederaStatus && error.hederaStatus !== error.code && (
          <>
            {" "}
            · Hedera status <code>{error.hederaStatus}</code>
          </>
        )}
        {error.transactionId && (
          <>
            {" "}
            · HCS transaction <code>{error.transactionId}</code>
          </>
        )}
        {error.transactionHash && (
          <>
            {" "}
            · Transaction <code>{error.transactionHash}</code>
          </>
        )}
        {hashscanUrl && (
          <>
            {" "}
            ·{" "}
            <a href={hashscanUrl} target="_blank" rel="noreferrer">
              HashScan ↗
            </a>
          </>
        )}
      </p>
    </div>
  );
}

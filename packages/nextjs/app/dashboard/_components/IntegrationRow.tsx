import type { IntegrationHealth } from "@sh/sdk";
import styles from "../dashboard.module.css";
import { StatusBadge } from "./StatusBadge";

export function IntegrationRow({ item }: { item: IntegrationHealth }) {
  return (
    <article className={`${styles.card} ${styles.integration}`} aria-labelledby={`integration-${item.id}`}>
      <div>
        <h3 id={`integration-${item.id}`}>{item.label}</h3>
        <StatusBadge status={item.status} transient={item.transient} />
      </div>
      <div>
        <p className={styles.summary}>{item.summary}</p>
        {item.status !== "ok" && item.remediation && (
          <p className={styles.fix}>
            <strong>Fix:</strong> {item.remediation}
            {item.variable && (
              <>
                {" "}
                (<code>{item.variable}</code>)
              </>
            )}
          </p>
        )}
        {item.transient && (
          <p className={styles.fix}>Connectivity only: the configuration is not proven wrong. Re-check in a moment.</p>
        )}
        {item.warnings.length > 0 && (
          <ul className={styles.notes}>
            {item.warnings.map(warning => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        {item.links.length > 0 && (
          <div className={styles.links}>
            {item.links.map(l => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer">
                {l.label} ↗
              </a>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

import type { ReactNode } from "react";
import type { HealthStatus } from "@sh/sdk";
import styles from "../dashboard.module.css";

const LOOK: Record<HealthStatus, { label: string; tone: string }> = {
  ok: { label: "OK", tone: styles.ok },
  error: { label: "Error", tone: styles.error },
  not_configured: { label: "Not configured", tone: styles.idle },
};

export function StatusBadge({ status, transient }: { status: HealthStatus; transient?: boolean }) {
  const look = LOOK[status];
  return (
    <span className={`${styles.badge} ${look.tone}`} role="status">
      {status === "error" && transient ? "Unreachable" : look.label}
    </span>
  );
}

export function Badge({ tone, children }: { tone: "ok" | "error" | "idle" | "warn"; children: ReactNode }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}

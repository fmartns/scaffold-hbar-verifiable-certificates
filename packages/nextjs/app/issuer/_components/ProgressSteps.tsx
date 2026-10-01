import type { ReactNode } from "react";
import styles from "../issuer.module.css";

export type StepState = "pending" | "active" | "done" | "failed";

export interface StepView {
  id: string;
  label: string;
  state: StepState;
  detail?: ReactNode;
}

const MARK: Record<StepState, string> = { pending: "○", active: "…", done: "✓", failed: "✕" };
const SR: Record<StepState, string> = { pending: "pending", active: "in progress", done: "done", failed: "failed" };

/** Live progress of a flow; announced to screen readers as it changes. */
export function ProgressSteps({ title, steps }: { title: string; steps: StepView[] }) {
  return (
    <ol className={styles.steps} aria-label={title} aria-live="polite">
      {steps.map(step => (
        <li key={step.id} className={styles[`step_${step.state}`]} data-state={step.state} data-step={step.id}>
          <span className={styles.stepMark} aria-hidden="true">
            {MARK[step.state]}
          </span>
          <span>
            {step.label} <span className={styles.srOnly}>({SR[step.state]})</span>
            {step.detail && <span className={styles.stepDetail}>{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

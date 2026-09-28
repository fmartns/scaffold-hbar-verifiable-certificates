"use client";

import { useState } from "react";
import type { HederaHealthReport } from "@sh/sdk";
import styles from "../dashboard.module.css";

/** Copies the report as JSON for a bug report. It holds no secret: keys never enter it and URLs are origins only. */
export function CopyDiagnosticsButton({ report }: { report: HederaHealthReport }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };
  return (
    <button type="button" className={styles.button} onClick={copy}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy diagnostics"}
    </button>
  );
}

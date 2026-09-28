"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import styles from "../dashboard.module.css";

/** Re-runs the server-side checks without a full page reload. */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className={styles.button}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? "Checking…" : "Re-check"}
    </button>
  );
}

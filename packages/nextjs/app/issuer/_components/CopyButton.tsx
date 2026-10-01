"use client";

import { useState } from "react";
import styles from "../issuer.module.css";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className={styles.linkButton} onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}

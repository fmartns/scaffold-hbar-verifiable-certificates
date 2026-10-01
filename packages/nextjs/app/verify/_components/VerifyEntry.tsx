"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "../verify.module.css";
import { extractCredentialId } from "../_lib/credentialId";
import { QrScanner } from "./QrScanner";

/**
 * The verifier's front door: a direct link already carries a `credentialId` (`/verify/<id>`), but anyone starting
 * from scratch — no link, only a QR code or an id read off a printed certificate — lands here first.
 */
export function VerifyEntry() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [notFound, setNotFound] = useState(false);

  const go = (raw: string) => {
    const id = extractCredentialId(raw);
    if (!id) {
      setNotFound(true);
      return;
    }
    setNotFound(false);
    router.push(`/verify/${id}`);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    go(value);
  };

  return (
    <section className={styles.card} aria-labelledby="entry-title">
      <h2 id="entry-title">Check a credential</h2>
      <p className={styles.muted}>Scan the QR code on the certificate, or type the credential id directly.</p>

      <QrScanner onScanned={go} />

      <form className={styles.form} onSubmit={onSubmit}>
        <div className={styles.field}>
          <label htmlFor="entry-credential-id">Credential id</label>
          <input
            id="entry-credential-id"
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="0x…"
            autoComplete="off"
          />
          <span className={styles.hint}>64 hex characters, starting with 0x.</span>
        </div>
        <div className={styles.actions}>
          <button type="submit" className={`${styles.button} ${styles.primary}`}>
            Verify
          </button>
        </div>
      </form>

      {notFound && (
        <p role="alert" className={styles.alert}>
          That does not look like a credential id. It should be 64 hex characters starting with <code>0x</code>, or a
          scanned <code>/verify/…</code> link.
        </p>
      )}
    </section>
  );
}

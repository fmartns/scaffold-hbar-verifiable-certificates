import type { Metadata } from "next";
import { VerifyEntry } from "./_components/VerifyEntry";
import styles from "./verify.module.css";

export const metadata: Metadata = { title: "Verify a credential · Verifiable Settlement" };

export default function VerifyIndexPage() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Verify a credential</h1>
        <p className={styles.subtitle}>
          Check whether a certificate is genuine — no wallet, no account, nothing to install.
        </p>
        <p className={styles.privacyNote}>
          The chain never stores names, e-mails or documents. Only hashes and status are public.
        </p>
      </header>
      <VerifyEntry />
    </main>
  );
}

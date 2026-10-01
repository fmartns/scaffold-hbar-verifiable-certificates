import type { Metadata } from "next";
import { isCredentialId } from "@sh/sdk/hedera/wallet";
import { VerifyResult } from "../_components/VerifyResult";
import styles from "../verify.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Credential verification · Verifiable Settlement" };

/**
 * Public, read-only credential verification: anyone with a `credentialId` or a QR code lands here directly, with
 * no wallet connection and no login. See `../_components/VerifyResult` for how the six core questions (existence,
 * issuer, integrity, issuance date, status, Hedera evidence) are answered.
 */
export default async function VerifyCredentialPage({ params }: { params: Promise<{ credentialId: string }> }) {
  const { credentialId: raw } = await params;
  const credentialId = raw.trim().toLowerCase();
  const isValidId = isCredentialId(credentialId);

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Credential verification</h1>
        <p className={styles.subtitle}>
          This page reads <code>CredentialRegistry</code> directly — the same source of truth the issuer and the Hedera
          network use. No wallet, no account.
        </p>
      </header>
      <VerifyResult credentialId={credentialId} isValidId={isValidId} />
    </main>
  );
}

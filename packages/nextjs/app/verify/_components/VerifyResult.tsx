"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { classifyIssuerError } from "@sh/sdk/hedera/wallet";
import type { CredentialStatusView, IssuerError } from "@sh/sdk/hedera/wallet";
import styles from "../verify.module.css";
import { createVerifierBackend } from "../_lib/api";
import type { VerifierBackend } from "../_lib/api";
import { QrCode } from "../../issuer/_components/QrCode";
import { StatusCard } from "./StatusCard";
import { EvidenceSection } from "./EvidenceSection";
import { HashCheck } from "./HashCheck";

const invalidId: IssuerError = {
  category: "invalid_input",
  code: "INVALID_CREDENTIAL_ID",
  title: "Invalid credential id",
  message: "credentialId must be 0x followed by 64 hex characters.",
  remediation: "Check the link or QR code and try again.",
};

/**
 * The public verification result for one `credentialId`: fetches `CredentialRegistry.statusOf` (the authority) and
 * renders the four questions it answers directly, then the Hedera evidence trail and the local integrity check.
 * No wallet, no login — every read goes through the existing public API routes
 * (`GET /api/credentials/status`, `GET /api/credentials/audit`) via `../_lib/api`, never re-implemented here.
 */
export function VerifyResult({
  credentialId,
  isValidId,
  backend,
  shareUrl,
}: {
  credentialId: string;
  isValidId: boolean;
  backend?: VerifierBackend;
  shareUrl?: string;
}) {
  const client = useMemo(() => backend ?? createVerifierBackend(), [backend]);
  const [view, setView] = useState<CredentialStatusView | null>(null);
  const [error, setError] = useState<IssuerError | null>(isValidId ? null : invalidId);
  const [loading, setLoading] = useState(isValidId);

  const load = useCallback(async () => {
    if (!isValidId) return;
    setLoading(true);
    setError(null);
    try {
      setView(await client.status(credentialId));
    } catch (e) {
      setError(classifyIssuerError(e));
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [client, credentialId, isValidId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <StatusCard credentialId={credentialId} view={view} error={error} loading={loading} />

      {!loading && error && (
        <section className={styles.card}>
          <button type="button" className={styles.button} onClick={() => void load()}>
            Retry
          </button>
        </section>
      )}

      {isValidId && (
        <>
          <section className={styles.card} aria-labelledby="share-title">
            <h2 id="share-title">Share this check</h2>
            <p className={styles.muted}>Anyone with this QR code or link lands directly on this result.</p>
            <QrCode value={shareUrl ?? `/verify/${credentialId}`} label="QR code of this verification link" />
          </section>

          <EvidenceSection credentialId={credentialId} fetchAudit={client.audit} />
          <HashCheck credentialId={credentialId} fetchAudit={client.audit} />
        </>
      )}

      <p className={styles.meta}>
        <Link href="/verify">Check another credential</Link>
      </p>
    </>
  );
}

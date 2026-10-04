import Link from "next/link";
import { notFound } from "next/navigation";
import { CertificateError } from "@sh/sdk/certificates";
import type { PublicCertificate } from "@sh/sdk/certificates";
import { certificateService } from "../../api/_lib/server";
import styles from "../../console.module.css";

export const dynamic = "force-dynamic";

/**
 * Where the QR code on the PDF leads. It shows what is public: the document and where it lives on Hedera, re-checked
 * against its HCS-1 memo. It cannot show whether the credential is revoked: AnonCreds keeps revocation indexes private,
 * so status is only ever proven by the holder, to a verifier, at a point in time.
 */
export default async function CertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let certificate: PublicCertificate;
  try {
    certificate = await (await certificateService()).publicCertificate(id);
  } catch (error) {
    if (!(error instanceof CertificateError)) throw error;
    // Without a published issuer there is no certificate to show.
    if (error.code === "NOT_FOUND" || error.code === "ISSUER_NOT_INITIALIZED") notFound();
    // A server that is not configured, or a Mirror Node that does not answer: explain instead of a bare 500.
    return (
      <main className={styles.main} style={{ maxWidth: 820 }}>
        <section className={styles.panel}>
          <h1>Certificate unavailable</h1>
          <p className={styles.error} role="alert">
            {error.message}
          </p>
          <p className={styles.muted}>
            The server could not load this certificate. Run <code>yarn setup</code> to check the environment.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.main} style={{ maxWidth: 820 }}>
      <section className={styles.panel}>
        <h1>{certificate.course}</h1>
        <p>
          Certificate of completion awarded to <strong>{certificate.holderName}</strong> by {certificate.issuerName} on{" "}
          {certificate.issuedOn}.
        </p>
        <dl className={styles.ids}>
          <dt>Document integrity</dt>
          <dd>
            {certificate.documentIntegrity.valid ? (
              <span className={styles.good}>VALID</span>
            ) : (
              <span className={styles.bad}>INVALID: {certificate.documentIntegrity.reason}</span>
            )}{" "}
            — re-read from HCS-1 and checked against the topic memo
          </dd>
          <dt>Document SHA-256</dt>
          <dd>
            <code>{certificate.documentSha256}</code>
          </dd>
          <dt>HCS-1 file</dt>
          <dd>
            <a href={certificate.links.documentTopic} target="_blank" rel="noreferrer">
              topic {certificate.documentTopicId}
            </a>{" "}
            ·{" "}
            <a href={certificate.links.documentMessages} target="_blank" rel="noreferrer">
              Mirror Node messages
            </a>
          </dd>
          <dt>Issuer</dt>
          <dd>
            <a href={certificate.links.issuerDid} target="_blank" rel="noreferrer">
              <code>{certificate.issuerDid}</code>
            </a>
          </dd>
          <dt>Credential definition</dt>
          <dd>
            <code>{certificate.credentialDefinitionId}</code>
          </dd>
          <dt>Certificate ID</dt>
          <dd>
            <code>{certificate.certificateId}</code>
          </dd>
        </dl>
        <p>
          <a href={`/api/certificates/${certificate.certificateId}/document`}>Download the PDF</a>
        </p>
        <h2>Is it still valid?</h2>
        <p className={styles.muted}>
          This page does not say, on purpose. The PDF only shows that the certificate was issued. Validity lives in the
          holder&apos;s AnonCreds credential: a verifier asks the holder for a proof, which shows that the credential is
          not revoked at a chosen time (checked against revocation state rebuilt from Hedera) and that its{" "}
          <code>document_sha256</code> is this document&apos;s hash. Copying the PDF does not copy the credential.
        </p>
        <p>
          <Link href="/">Open the console</Link> to run that check as Platform B.
        </p>
      </section>
    </main>
  );
}

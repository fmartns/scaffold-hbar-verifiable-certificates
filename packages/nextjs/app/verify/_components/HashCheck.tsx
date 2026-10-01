"use client";

import { useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { classifyIssuerError, deriveCredential } from "@sh/sdk/hedera/wallet";
import type { IssuerError } from "@sh/sdk/hedera/wallet";
import styles from "../verify.module.css";
import type { VerifierBackend } from "../_lib/api";
import { ErrorCallout } from "../../issuer/_components/ErrorCallout";

type Outcome =
  | { kind: "match"; credentialHash: string }
  | { kind: "mismatch"; reason: "hash" | "subject" | "wrong-credential"; expected: string; got: string }
  | { kind: "not_on_chain" }
  | { kind: "invalid_document"; issues: { field: string; message: string }[] }
  | { kind: "invalid_json" }
  | { kind: "error"; error: IssuerError };

/**
 * Answers "was the document altered?" without sending the document anywhere: `deriveCredential` (the SDK's single,
 * pure implementation of docs/credential-schema.md, `@sh/sdk/hedera/credentials/schema.ts`) recomputes
 * `credentialHash` and `subjectCommitment` from the pasted/uploaded JSON entirely in this browser, then compares
 * them against the on-chain record fetched for display. The chain never stores the document, a name, an e-mail or
 * any other personal identifier — only these hash commitments — so this check never uploads the file either.
 */
export function HashCheck({
  credentialId,
  fetchAudit,
}: {
  credentialId: string;
  fetchAudit: VerifierBackend["audit"];
}) {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [checking, setChecking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // FileReader, not `file.text()`: broadly supported, including in this project's jsdom test environment.
    const reader = new FileReader();
    reader.onload = () => setText(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
    if (fileInput.current) fileInput.current.value = "";
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setOutcome(null);
    try {
      let document: unknown;
      try {
        document = JSON.parse(text);
      } catch {
        setOutcome({ kind: "invalid_json" });
        return;
      }
      const derived = deriveCredential(document);
      if (!derived.ok) {
        setOutcome({ kind: "invalid_document", issues: derived.issues });
        return;
      }
      if (derived.value.credentialId.toLowerCase() !== credentialId.toLowerCase()) {
        setOutcome({
          kind: "mismatch",
          reason: "wrong-credential",
          expected: credentialId,
          got: derived.value.credentialId,
        });
        return;
      }
      const report = await fetchAudit(credentialId);
      const record = report.onChain.record;
      if (!record) {
        setOutcome({ kind: "not_on_chain" });
        return;
      }
      if (record.subjectCommitment.toLowerCase() !== derived.value.subjectCommitment.toLowerCase()) {
        setOutcome({
          kind: "mismatch",
          reason: "subject",
          expected: record.subjectCommitment,
          got: derived.value.subjectCommitment,
        });
        return;
      }
      if (record.credentialHash.toLowerCase() !== derived.value.credentialHash.toLowerCase()) {
        setOutcome({
          kind: "mismatch",
          reason: "hash",
          expected: record.credentialHash,
          got: derived.value.credentialHash,
        });
        return;
      }
      setOutcome({ kind: "match", credentialHash: record.credentialHash });
    } catch (error) {
      setOutcome({ kind: "error", error: classifyIssuerError(error) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="hash-check-title">
      <h2 id="hash-check-title">Was the document altered?</h2>
      <p className={styles.muted}>
        If the holder gave you the original credential JSON, paste or upload it here to recompute its on-chain
        commitment in this browser and compare it with the registered record. The document — including any personal
        identifier it contains — is never sent anywhere; the chain only ever stores a hash of it.
      </p>
      <form className={styles.form} onSubmit={onSubmit}>
        <div className={styles.field}>
          <label htmlFor="hash-check-document">Credential JSON</label>
          <textarea
            id="hash-check-document"
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder='{"version":1,"issuer":"acme-university", ...}'
            spellCheck={false}
          />
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={() => fileInput.current?.click()}>
            Upload file…
          </button>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={onFile} />
          <button
            type="submit"
            className={`${styles.button} ${styles.primary}`}
            disabled={checking || text.trim().length === 0}
          >
            {checking ? "Checking…" : "Check integrity"}
          </button>
        </div>
      </form>

      {outcome && <Result outcome={outcome} />}
    </section>
  );
}

function Result({ outcome }: { outcome: Outcome }) {
  switch (outcome.kind) {
    case "match":
      return (
        <p className={`${styles.badges}`}>
          <span className={`${styles.badge} ${styles.ok}`}>Content matches</span>
          <span className={styles.muted}>
            The recomputed <code>credentialHash</code> equals the on-chain record. This document is the exact one that
            was issued.
          </span>
        </p>
      );
    case "mismatch":
      return (
        <div className={styles.alert} role="alert">
          <strong>Content diverges</strong>
          <p>
            {outcome.reason === "wrong-credential"
              ? "This document belongs to a different credential: its derived credentialId does not match the one being verified."
              : outcome.reason === "subject"
                ? "The holder identifier (subject commitment) recomputed from this document does not match the on-chain record."
                : "The recomputed credentialHash does not match the on-chain record. The content, dates or claims in this document differ from what was issued."}
          </p>
          <p className={styles.meta}>
            On-chain <code>{outcome.expected}</code>
            <br />
            From document <code>{outcome.got}</code>
          </p>
        </div>
      );
    case "not_on_chain":
      return (
        <div className={styles.notice} role="alert">
          <strong>Cannot compare</strong>
          <p>This credential has no on-chain record yet, so there is nothing to compare the document against.</p>
        </div>
      );
    case "invalid_json":
      return (
        <div className={styles.alert} role="alert">
          <strong>Invalid input</strong>
          <p>That text is not valid JSON.</p>
        </div>
      );
    case "invalid_document":
      return (
        <div className={styles.alert} role="alert">
          <strong>Not a recognizable credential document</strong>
          <ul className={styles.hint}>
            {outcome.issues.map(issue => (
              <li key={`${issue.field}-${issue.message}`}>
                <code>{issue.field}</code>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      );
    case "error":
      return <ErrorCallout error={outcome.error} />;
  }
}

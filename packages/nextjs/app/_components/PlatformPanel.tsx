"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../_lib/api";
import type { ConsoleState, Decision, DocumentCheck } from "../_lib/api";
import styles from "../console.module.css";

const NEVER_SHARED = ["holder_name", "student_id", "grade (the value)", "document_sha256"];
const utc = (seconds: number) => new Date(seconds * 1000).toISOString().replace(".000Z", "Z");

function DecisionCard({ title, decision }: { title: string; decision: Decision }) {
  const request = decision.request;
  const asOf = request?.non_revoked?.to;
  const revealed = decision.verification?.revealed ?? {};
  return (
    <article className={styles.card} aria-label={title}>
      <header>
        <span className={decision.approved ? styles.good : styles.bad}>
          {decision.approved ? "ENROLLED" : "DENIED"}
        </span>{" "}
        {title}
      </header>
      {request && (
        <>
          <p className={styles.muted}>Platform B asked for:</p>
          <ul>
            {Object.values(request.requested_attributes).map(attribute => (
              <li key={attribute.name}>
                <code>{attribute.name}</code> revealed
              </li>
            ))}
            {Object.values(request.requested_predicates).map(predicate => (
              <li key={predicate.name}>
                <code>
                  {predicate.name} {predicate.p_type} {predicate.p_value}
                </code>{" "}
                proven without the value
              </li>
            ))}
            {asOf !== undefined && <li>not revoked at {utc(asOf)} (Hedera consensus time)</li>}
            <li>issued under a credential definition the accreditation registry lists for the course</li>
          </ul>
        </>
      )}
      {decision.verification ? (
        <>
          <p className={styles.muted}>Platform B received:</p>
          <ul>
            {Object.entries(revealed).map(([name, value]) => (
              <li key={name}>
                <code>{name}</code> = {value}
              </li>
            ))}
            {decision.verification.predicates.map(predicate => (
              <li key={predicate}>
                <code>{predicate}</code>: {decision.verification?.verified ? "true" : "not proven"}
              </li>
            ))}
          </ul>
          <p className={styles.muted}>
            Never shared: {NEVER_SHARED.filter(name => !(name in revealed)).join(", ")}. Schema, credential definition
            and revocation state were read from Hedera, not from the issuer.
          </p>
          {decision.accreditation && (
            <p className={styles.muted}>
              Accreditation registry: the credential definition was{" "}
              <strong>{decision.accreditation.accredited ? "accredited" : "not accredited"}</strong> for the course at
              that time.
            </p>
          )}
        </>
      ) : (
        <p className={styles.muted}>No proof was presented.</p>
      )}
      {decision.reasons.length > 0 && (
        <ul className={styles.reasons}>
          {decision.reasons.map(reason => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function DocumentCard({ check }: { check: DocumentCheck }) {
  const proven = check.verification;
  return (
    <article className={styles.card} aria-label="Document check">
      <dl className={styles.ids}>
        <dt>Document integrity</dt>
        <dd className={check.documentMatches ? styles.good : styles.bad}>
          {check.documentMatches ? "MATCH" : "MISMATCH"}
        </dd>
        <dt>Credential status</dt>
        <dd className={proven?.verified ? styles.good : styles.bad}>
          {!proven ? "NO PROOF" : proven.verified ? "VALID" : "REVOKED OR INVALID"}
        </dd>
        <dt>SHA-256 of the file</dt>
        <dd>
          <code>{check.fileSha256}</code>
        </dd>
        <dt>Hash in the credential</dt>
        <dd>
          <code>{proven?.revealed.document_sha256 ?? "—"}</code>
        </dd>
      </dl>
      {check.reasons.length > 0 && (
        <ul className={styles.reasons}>
          {check.reasons.map(reason => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function PlatformPanel({
  state,
  run,
}: {
  state: ConsoleState;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<{ title: string; decision: Decision }[]>([]);
  const [asOf, setAsOf] = useState("");
  const [check, setCheck] = useState<DocumentCheck | null>(null);
  const [documentHolder, setDocumentHolder] = useState("ana");
  const [certificateId, setCertificateId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const ready = state.issuer !== null;

  const enroll = (holder: string, at?: number) => {
    const title = `${holder} → ${state.policy.offering}${at ? ` as of ${utc(at)}` : ""}`;
    void run(`Platform B is verifying ${holder}'s proof`, async () => {
      const decision = await api.enroll(holder, at);
      setDecisions(previous => [{ title, decision }, ...previous].slice(0, 4));
    });
  };

  const submitDocument = (event: FormEvent) => {
    event.preventDefault();
    if (!file || !certificateId) return;
    void run("Platform B is checking the document", async () =>
      setCheck(await api.checkDocument(documentHolder, certificateId, file)),
    );
  };

  return (
    <section className={styles.panel} aria-labelledby="platform-title">
      <h2 id="platform-title">2. Platform B · enrollment in {state.policy.offering}</h2>
      <p className={styles.muted}>
        Rule: a non-revoked “{state.policy.prerequisite}” certificate from {state.issuerName} with grade ≥{" "}
        {state.policy.minimumGrade}. Platform B never contacts the issuer.
      </p>
      <div className={styles.actions}>
        {state.holders.map(holder => (
          <button key={holder} type="button" disabled={!ready} onClick={() => enroll(holder)}>
            {holder} applies
          </button>
        ))}
      </div>
      <div className={styles.actions}>
        <label>
          Was it valid at (UTC)?
          <input type="datetime-local" step={1} value={asOf} onChange={e => setAsOf(e.target.value)} />
        </label>
        <button
          type="button"
          disabled={!ready || !asOf}
          onClick={() => enroll("ana", Math.floor(new Date(`${asOf}Z`).getTime() / 1000))}
        >
          Check ana at that time
        </button>
      </div>
      {decisions.map(({ title, decision }, index) => (
        <DecisionCard key={`${title}-${index}`} title={title} decision={decision} />
      ))}

      <form className={styles.form} onSubmit={submitDocument}>
        <h3>Check a downloaded certificate</h3>
        <label>
          Certificate
          <select value={certificateId} onChange={e => setCertificateId(e.target.value)}>
            <option value="">Choose…</option>
            {state.certificates.map(c => (
              <option key={c.certificateId} value={c.certificateId}>
                {c.holderName} · {c.course} · {c.certificateId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Holder who presents it
          <select value={documentHolder} onChange={e => setDocumentHolder(e.target.value)}>
            {state.holders.map(holder => (
              <option key={holder}>{holder}</option>
            ))}
          </select>
        </label>
        <label>
          PDF file
          <input type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button type="submit" disabled={!ready || !file || !certificateId}>
          Check document
        </button>
      </form>
      {check && <DocumentCard check={check} />}
    </section>
  );
}

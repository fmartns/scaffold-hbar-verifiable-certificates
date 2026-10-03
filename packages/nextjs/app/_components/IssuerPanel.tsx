"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../_lib/api";
import type { ConsoleState } from "../_lib/api";
import styles from "../console.module.css";

const topicUrl = (state: ConsoleState, topicId: string) => `${state.hashscanUrl}/topic/${topicId}`;

export function IssuerPanel({
  state,
  run,
}: {
  state: ConsoleState;
  run: (label: string, action: () => Promise<unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    holder: "ana",
    holderName: "Ana Example",
    studentId: "123456",
    course: state.policy.prerequisite,
    grade: 88,
  });
  const { issuer, accreditation } = state;

  const issue = (event: FormEvent) => {
    event.preventDefault();
    void run("Issuing: PDF to HCS-1, then the credential (about 20 s)", () => api.issue(form));
  };

  return (
    <section className={styles.panel} aria-labelledby="issuer-title">
      <h2 id="issuer-title">1. Issuer · {state.issuerName}</h2>
      {issuer ? (
        <dl className={styles.ids}>
          <dt>DID</dt>
          <dd>
            <a href={topicUrl(state, issuer.issuerDid.split("_").pop() ?? "")} target="_blank" rel="noreferrer">
              <code>{issuer.issuerDid}</code>
            </a>
          </dd>
          <dt>Credential definition</dt>
          <dd>
            <code>{issuer.credentialDefinitionId}</code>
          </dd>
          <dt>Revocation entries</dt>
          <dd>
            <a href={topicUrl(state, issuer.revocationEntriesTopicId)} target="_blank" rel="noreferrer">
              topic {issuer.revocationEntriesTopicId}
            </a>{" "}
            — the state verifiers rebuild
          </dd>
          {accreditation && (
            <>
              <dt>Accreditation</dt>
              <dd>
                <a href={`${state.hashscanUrl}/contract/${accreditation.contractId}`} target="_blank" rel="noreferrer">
                  registry {accreditation.contractId}
                </a>
                : {accreditation.withdrawnAt ? "withdrawn" : "accredited"} for “{accreditation.course}”{" "}
                <span className={accreditation.withdrawnAt ? styles.bad : styles.good}>
                  {accreditation.withdrawnAt ? "withdrawn" : "active"}
                </span>{" "}
                {!accreditation.withdrawnAt && (
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => run("The authority withdraws the accreditation", api.withdrawAccreditation)}
                  >
                    Withdraw (authority)
                  </button>
                )}
              </dd>
            </>
          )}
        </dl>
      ) : (
        <div className={styles.callout}>
          <p>The issuer is not published on {state.network} yet.</p>
          <button
            type="button"
            onClick={() => run("Publishing the issuer and the accreditation registry on Hedera", api.initialize)}
          >
            Publish issuer on Hedera
          </button>
        </div>
      )}

      <form className={styles.form} onSubmit={issue}>
        <h3>Issue a certificate</h3>
        <label>
          Holder wallet
          <select value={form.holder} onChange={e => setForm({ ...form, holder: e.target.value })}>
            {state.holders.map(holder => (
              <option key={holder}>{holder}</option>
            ))}
          </select>
        </label>
        <label>
          Name on the certificate
          <input value={form.holderName} onChange={e => setForm({ ...form, holderName: e.target.value })} />
        </label>
        <label>
          Student id <small>(credential only, never on the PDF)</small>
          <input value={form.studentId} onChange={e => setForm({ ...form, studentId: e.target.value })} />
        </label>
        <label>
          Course
          <input value={form.course} onChange={e => setForm({ ...form, course: e.target.value })} />
        </label>
        <label>
          Grade <small>(credential only)</small>
          <input
            type="number"
            min={0}
            max={100}
            value={form.grade}
            onChange={e => setForm({ ...form, grade: Number(e.target.value) })}
          />
        </label>
        <button type="submit" disabled={!issuer}>
          Issue certificate
        </button>
      </form>

      <h3>Issued certificates</h3>
      {state.certificates.length === 0 ? (
        <p className={styles.muted}>None yet.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Holder</th>
              <th>Course</th>
              <th>Document (HCS-1)</th>
              <th>Issuer register</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...state.certificates].reverse().map(certificate => (
              <tr key={certificate.certificateId}>
                <td>
                  {certificate.holderName} <small>({certificate.holder})</small>
                </td>
                <td>{certificate.course}</td>
                <td>
                  <a href={api.documentUrl(certificate.certificateId)}>Download PDF</a> ·{" "}
                  <a href={`/certificate/${certificate.certificateId}`}>Public page</a> ·{" "}
                  <a href={topicUrl(state, certificate.documentTopicId)} target="_blank" rel="noreferrer">
                    {certificate.documentTopicId}
                  </a>
                </td>
                <td>
                  <span className={certificate.revokedAt ? styles.bad : styles.good}>
                    {certificate.revokedAt ? "revoked" : "issued"}
                  </span>
                </td>
                <td>
                  {!certificate.revokedAt && (
                    <button
                      type="button"
                      className={styles.danger}
                      onClick={() => run("Revoking on Hedera", () => api.revoke(certificate.certificateId))}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

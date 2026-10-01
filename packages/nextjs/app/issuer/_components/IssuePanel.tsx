"use client";

import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  CREDENTIAL_SCHEMA_PRESETS,
  DEFAULT_SIGNATURE_WINDOW_SECONDS,
  SUBJECT_ID_TYPES,
  classifyIssuerError,
  findSchemaPreset,
  runIssuance,
} from "@sh/sdk/hedera/wallet";
import type {
  CredentialPublishReceipt,
  IssuanceOutcome,
  IssuanceStep,
  IssuerError,
  IssuerFlowContext,
} from "@sh/sdk/hedera/wallet";
import { applyProgress, failActive, initialSteps } from "../_lib/progress";
import type { StepStates } from "../_lib/progress";
import styles from "../issuer.module.css";
import { ErrorCallout } from "./ErrorCallout";
import { IssuanceResult } from "./IssuanceResult";
import { ProgressSteps } from "./ProgressSteps";

const STEPS: readonly IssuanceStep[] = ["build", "sign", "simulate", "publish", "register", "confirm"];
const LABELS: Record<IssuanceStep, string> = {
  build: "Credential built (fields hashed in this browser)",
  sign: "Signed by the issuer wallet (EIP-712)",
  simulate: "Dry-run accepted by CredentialRegistry",
  publish: "Published to HCS (consensus receipt)",
  register: "Registry transaction sent",
  confirm: "Registered on CredentialRegistry",
};

interface FormState {
  issuerName: string;
  schema: string;
  reference: string;
  subjectIdType: string;
  subjectIdValue: string;
  issuedOn: string;
  expiresOn: string;
  validityMinutes: string;
}

const EMPTY: FormState = {
  issuerName: "",
  schema: "",
  reference: "",
  subjectIdType: "",
  subjectIdValue: "",
  issuedOn: "",
  expiresOn: "",
  validityMinutes: String(DEFAULT_SIGNATURE_WINDOW_SECONDS / 60),
};

const FIELD_OF: Record<string, string> = { validitySeconds: "validityMinutes" };

export function IssuePanel({
  context,
  disabled,
  onIssued,
}: {
  context: () => IssuerFlowContext;
  disabled: boolean;
  onIssued: (outcome: IssuanceOutcome) => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [claims, setClaims] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepStates<IssuanceStep> | null>(null);
  const [hcs, setHcs] = useState<CredentialPublishReceipt | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<IssuerError | null>(null);
  const [outcome, setOutcome] = useState<IssuanceOutcome | null>(null);

  const fieldErrors = Object.fromEntries(
    (error?.category === "invalid_input" ? (error.issues ?? []) : []).map(i => [
      FIELD_OF[i.field] ?? i.field,
      i.message,
    ]),
  ) as Partial<Record<string, string>>;

  const set = (field: keyof FormState) => (value: string) => setForm(f => ({ ...f, [field]: value }));
  const preset = findSchemaPreset(form.schema);
  const subjectType = SUBJECT_ID_TYPES.find(t => t.name === form.subjectIdType);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    setOutcome(null);
    setHcs(null);
    setTxHash(null);
    let current = initialSteps(STEPS);
    setSteps(current);
    try {
      const result = await runIssuance(
        {
          issuerName: form.issuerName,
          schema: form.schema,
          reference: form.reference,
          subjectIdType: form.subjectIdType,
          subjectIdValue: form.subjectIdValue,
          issuedOn: form.issuedOn,
          expiresOn: form.expiresOn,
          claims,
          validitySeconds: Math.round(Number(form.validityMinutes) * 60),
        },
        context(),
        progress => {
          current = applyProgress(current, progress);
          setSteps(current);
          if (progress.step === "publish" && progress.state === "done") {
            setHcs(progress.detail?.hcs as CredentialPublishReceipt);
          }
          if (progress.step === "register" && progress.state === "done") {
            setTxHash(String(progress.detail?.transactionHash));
          }
        },
      );
      setOutcome(result);
      // The holder identifier is not kept once the credential exists.
      setForm(f => ({ ...f, subjectIdValue: "" }));
      onIssued(result);
    } catch (e) {
      setSteps(failActive(current));
      setError(classifyIssuerError(e));
    } finally {
      setRunning(false);
    }
  }

  const stepDetail = (step: IssuanceStep) => {
    if (step === "publish" && hcs) {
      return (
        <>
          Topic {hcs.topicId} · sequence {hcs.hcsRef.sequence} ·{" "}
          {hcs.hashscanUrl ? (
            <a href={hcs.hashscanUrl} target="_blank" rel="noreferrer">
              {hcs.transactionId} ↗
            </a>
          ) : (
            <code>{hcs.transactionId}</code>
          )}
        </>
      );
    }
    if (step === "register" && txHash) return <code>{txHash}</code>;
    return undefined;
  };

  return (
    <section className={styles.card} aria-labelledby="issue-title">
      <h2 id="issue-title">Issue a credential</h2>
      <form onSubmit={submit} noValidate className={styles.form}>
        <Field
          label="Issuer namespace"
          error={fieldErrors.issuerName}
          hint="The namespace registered for your wallet: lowercase words separated by - or ."
        >
          {id => (
            <input
              id={id}
              name="issuerName"
              placeholder="acme-university"
              value={form.issuerName}
              onChange={e => set("issuerName")(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <Field label="Credential type" error={fieldErrors.schema}>
          {id => (
            <select
              id={id}
              name="schema"
              value={form.schema}
              onChange={e => {
                set("schema")(e.target.value);
                setClaims({});
              }}
              required
            >
              <option value="" disabled>
                Selecione…
              </option>
              {CREDENTIAL_SCHEMA_PRESETS.map(p => (
                <option key={p.descriptor} value={p.descriptor}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        {preset && (
          <p className={styles.hint}>
            Schema <code>{preset.descriptor}</code>
          </p>
        )}
        <Field
          label="Credential reference"
          error={fieldErrors.reference}
          hint="Your permanent serial for this credential; it defines the credential ID. No personal data."
        >
          {id => (
            <input
              id={id}
              name="reference"
              placeholder={preset?.referencePlaceholder ?? "ENR-2026-0042"}
              value={form.reference}
              onChange={e => set("reference")(e.target.value)}
              required
            />
          )}
        </Field>
        {preset?.claims.map(claim => (
          <Field
            key={claim.name}
            label={claim.label}
            error={fieldErrors[`claims.${claim.name}`]}
            hint={claim.input === "date" ? "YYYY-MM-DD" : undefined}
          >
            {id => (
              <input
                id={id}
                name={`claims.${claim.name}`}
                placeholder={claim.placeholder}
                inputMode={claim.input === "number" || claim.input === "date" ? "numeric" : undefined}
                value={claims[claim.name] ?? ""}
                onChange={e => setClaims(c => ({ ...c, [claim.name]: e.target.value }))}
                required
              />
            )}
          </Field>
        ))}
        <Field label="Holder identifier type" error={fieldErrors.subjectIdType}>
          {id => (
            <select
              id={id}
              name="subjectIdType"
              value={form.subjectIdType}
              onChange={e => set("subjectIdType")(e.target.value)}
              required
            >
              <option value="" disabled>
                Selecione…
              </option>
              {SUBJECT_ID_TYPES.map(t => (
                <option key={t.name} value={t.name}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          label="Holder identifier"
          error={fieldErrors.subjectIdValue}
          hint="Normalized and hashed with a random salt in this browser. Never sent or stored."
        >
          {id => (
            <input
              id={id}
              name="subjectIdValue"
              placeholder={subjectType?.placeholder ?? "maria.silva@example.com"}
              value={form.subjectIdValue}
              onChange={e => set("subjectIdValue")(e.target.value)}
              autoComplete="off"
              required
            />
          )}
        </Field>
        <Field label="Issue date" error={fieldErrors.issuedOn} hint="YYYY-MM-DD, the date printed on the credential">
          {id => (
            <input
              id={id}
              name="issuedOn"
              placeholder="2026-09-21"
              inputMode="numeric"
              pattern="\d{4}-\d{2}-\d{2}"
              value={form.issuedOn}
              onChange={e => set("issuedOn")(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Expiry date" error={fieldErrors.expiresOn} hint="YYYY-MM-DD; leave empty if it never expires">
          {id => (
            <input
              id={id}
              name="expiresOn"
              placeholder="2028-09-21"
              inputMode="numeric"
              pattern="\d{4}-\d{2}-\d{2}"
              value={form.expiresOn}
              onChange={e => set("expiresOn")(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Signature window (minutes)"
          error={fieldErrors.validityMinutes}
          hint="How long the signed issuance can be submitted."
        >
          {id => (
            <input
              id={id}
              name="validityMinutes"
              type="number"
              min={1}
              placeholder="10"
              value={form.validityMinutes}
              onChange={e => set("validityMinutes")(e.target.value)}
              required
            />
          )}
        </Field>
        <div className={styles.actions}>
          <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={disabled || running}>
            {running ? "Issuing…" : "Issue credential"}
          </button>
        </div>
      </form>

      {steps && (
        <ProgressSteps
          title="Issuance progress"
          steps={STEPS.map(id => ({ id, label: LABELS[id], state: steps[id], detail: stepDetail(id) }))}
        />
      )}
      {error && <ErrorCallout error={error} hashscanUrl={hcs?.hashscanUrl} />}
      {outcome && <IssuanceResult outcome={outcome} />}
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (id: string) => ReactNode;
}) {
  const id = `issue-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className={styles.field} data-invalid={error ? "true" : undefined}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? (
        <span className={styles.fieldError} role="status">
          {error}
        </span>
      ) : (
        hint && <span className={styles.hint}>{hint}</span>
      )}
    </div>
  );
}

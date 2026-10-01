"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { REVOCATION_REASONS, classifyIssuerError, isCredentialId, runRevocation } from "@sh/sdk/hedera/wallet";
import type {
  CredentialPublishReceipt,
  IssuerError,
  IssuerFlowContext,
  RevocationOutcome,
  RevocationReason,
  RevocationStep,
} from "@sh/sdk/hedera/wallet";
import { applyProgress, failActive, initialSteps } from "../_lib/progress";
import type { StepStates } from "../_lib/progress";
import styles from "../issuer.module.css";
import { ErrorCallout } from "./ErrorCallout";
import { ProgressSteps } from "./ProgressSteps";

const STEPS: readonly RevocationStep[] = ["status", "sign", "simulate", "publish", "revoke", "confirm"];
const LABELS: Record<RevocationStep, string> = {
  status: "Credential found and still issued",
  sign: "Revocation evidence signed by the issuer wallet (EIP-712)",
  simulate: "Dry-run accepted by CredentialRegistry",
  publish: "Revocation published to HCS (consensus receipt)",
  revoke: "Revoke transaction sent",
  confirm: "Revoked on CredentialRegistry",
};

const reasonLabel = (reason: string) => REVOCATION_REASONS.find(r => r.name === reason)?.label ?? reason;

export function RevokePanel({
  context,
  disabled,
  preset,
  onRevoked,
}: {
  context: () => IssuerFlowContext;
  disabled: boolean;
  /** A credential ID chosen elsewhere (activity list); fills the field. */
  preset: { credentialId: string; nonce: number } | null;
  onRevoked: (outcome: RevocationOutcome) => void;
}) {
  const [credentialId, setCredentialId] = useState("");
  const [reason, setReason] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ credentialId?: string; reason?: string }>({});
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepStates<RevocationStep> | null>(null);
  const [hcs, setHcs] = useState<CredentialPublishReceipt | null>(null);
  const [error, setError] = useState<IssuerError | null>(null);
  const [outcome, setOutcome] = useState<RevocationOutcome | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (preset) {
      setCredentialId(preset.credentialId);
      setConfirming(false);
    }
  }, [preset]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  function requestConfirmation(event: FormEvent) {
    event.preventDefault();
    const errors: typeof fieldErrors = {};
    if (!isCredentialId(credentialId)) errors.credentialId = "Enter a credential ID: 0x followed by 64 hex characters.";
    if (!reason) errors.reason = "Select a revocation reason.";
    setFieldErrors(errors);
    setError(null);
    setOutcome(null);
    if (Object.keys(errors).length === 0) setConfirming(true);
  }

  async function revoke() {
    setConfirming(false);
    setRunning(true);
    setHcs(null);
    let current = initialSteps(STEPS);
    setSteps(current);
    try {
      const result = await runRevocation(
        { credentialId: credentialId.trim(), reason: reason as RevocationReason },
        context(),
        progress => {
          current = applyProgress(current, progress);
          setSteps(current);
          if (progress.step === "publish" && progress.state === "done") {
            setHcs(progress.detail?.hcs as CredentialPublishReceipt);
          }
        },
      );
      setOutcome(result);
      onRevoked(result);
    } catch (e) {
      setSteps(failActive(current));
      setError(classifyIssuerError(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="revoke-title">
      <h2 id="revoke-title">Revoke a credential</h2>
      <form onSubmit={requestConfirmation} noValidate className={styles.form}>
        <div className={styles.field} data-invalid={fieldErrors.credentialId ? "true" : undefined}>
          <label htmlFor="revoke-credential-id">Credential ID</label>
          <input
            id="revoke-credential-id"
            name="credentialId"
            placeholder="0x8a1c2e4f6b7d9e0a1c3e5f7b9d1e3a5c7e9f1b3d5a7c9e1f3b5d7a9c1e3f5b7d"
            value={credentialId}
            onChange={e => {
              setCredentialId(e.target.value);
              setConfirming(false);
            }}
            autoComplete="off"
            spellCheck={false}
            required
          />
          {fieldErrors.credentialId && (
            <span className={styles.fieldError} role="status">
              {fieldErrors.credentialId}
            </span>
          )}
        </div>
        <div className={styles.field} data-invalid={fieldErrors.reason ? "true" : undefined}>
          <label htmlFor="revoke-reason">Reason</label>
          <select
            id="revoke-reason"
            name="reason"
            value={reason}
            onChange={e => {
              setReason(e.target.value);
              setConfirming(false);
            }}
            required
          >
            <option value="" disabled>
              Selecione…
            </option>
            {REVOCATION_REASONS.map(r => (
              <option key={r.name} value={r.name}>
                {r.label}
              </option>
            ))}
          </select>
          {fieldErrors.reason ? (
            <span className={styles.fieldError} role="status">
              {fieldErrors.reason}
            </span>
          ) : (
            <span className={styles.hint}>Recorded as a reason code in the HCS revocation evidence.</span>
          )}
        </div>
        <div className={styles.actions}>
          <button type="submit" className={`${styles.button} ${styles.danger}`} disabled={disabled || running}>
            {running ? "Revoking…" : "Revoke…"}
          </button>
        </div>
      </form>

      {confirming && (
        <div
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="revoke-confirm-title"
          aria-describedby="revoke-confirm-text"
          className={styles.confirm}
        >
          <strong id="revoke-confirm-title">Revoke this credential?</strong>
          <p id="revoke-confirm-text">
            <code>{credentialId.trim()}</code> will be revoked for “{reasonLabel(reason)}”. Revocation is final: the
            credential can never be issued again under this ID. The wallet will ask you to sign the evidence and then to
            send the transaction.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button ref={confirmRef} type="button" className={`${styles.button} ${styles.danger}`} onClick={revoke}>
              Confirm revocation
            </button>
          </div>
        </div>
      )}

      {steps && (
        <ProgressSteps
          title="Revocation progress"
          steps={STEPS.map(id => ({
            id,
            label: LABELS[id],
            state: steps[id],
            detail:
              id === "publish" && hcs ? (
                hcs.hashscanUrl ? (
                  <a href={hcs.hashscanUrl} target="_blank" rel="noreferrer">
                    {hcs.transactionId} ↗
                  </a>
                ) : (
                  <code>{hcs.transactionId}</code>
                )
              ) : undefined,
          }))}
        />
      )}
      {error && <ErrorCallout error={error} hashscanUrl={hcs?.hashscanUrl} />}
      {outcome && (
        <div className={styles.result} role="status" aria-label="Revocation result">
          <div className={styles.resultBody}>
            <h3>Credential revoked</h3>
            <dl className={styles.facts}>
              <dt>Credential ID</dt>
              <dd>
                <code>{outcome.credentialId}</code>
              </dd>
              <dt>HCS evidence</dt>
              <dd>
                {outcome.hcs.hashscanUrl ? (
                  <a href={outcome.hcs.hashscanUrl} target="_blank" rel="noreferrer">
                    View on HashScan ↗
                  </a>
                ) : (
                  <code>{outcome.hcs.transactionId}</code>
                )}
              </dd>
              <dt>Revoke transaction</dt>
              <dd>
                <code>{outcome.registration.transactionHash}</code>
              </dd>
            </dl>
          </div>
        </div>
      )}
    </section>
  );
}

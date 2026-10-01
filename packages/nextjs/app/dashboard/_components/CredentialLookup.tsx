"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { HederaNetworkName } from "@sh/sdk/hedera/networks";
import { useCredentialRegistry } from "~~/hooks/useCredentialRegistry";
import styles from "../dashboard.module.css";
import { Badge } from "./StatusBadge";

const STATUS_TONE = { issued: "ok", revoked: "error", not_found: "idle" } as const;

const formatTime = (seconds: bigint) =>
  seconds === 0n ? "—" : new Date(Number(seconds) * 1000).toLocaleString("en-GB", { timeZone: "UTC" }) + " UTC";

/** Reads a credential's on-chain status through `useCredentialRegistry` (address and ABI from the codegen manifest). */
export function CredentialLookup({ network, address }: { network: HederaNetworkName; address: string | null }) {
  const { deployment, lookup, getCredentialStatus } = useCredentialRegistry({ network, address });
  const [credentialId, setCredentialId] = useState("");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void getCredentialStatus(credentialId);
  };

  return (
    <section className={styles.card} aria-labelledby="lookup-title">
      <h2 id="lookup-title">Credential status</h2>
      {deployment.status !== "ready" ? (
        <p className={styles.fix}>{deployment.message}</p>
      ) : (
        <>
          <dl className={styles.facts}>
            <dt>Registry</dt>
            <dd>
              <code>{deployment.contract.contractId ?? deployment.contract.address}</code>{" "}
              <span className={styles.muted}>
                ({deployment.contract.source === "manifest" ? "generated manifest" : "configured address"})
              </span>
              {deployment.contract.hashscanUrl && (
                <>
                  {" · "}
                  <a href={deployment.contract.hashscanUrl} target="_blank" rel="noreferrer">
                    HashScan ↗
                  </a>
                </>
              )}
            </dd>
          </dl>
          <form className={styles.lookupForm} onSubmit={onSubmit}>
            <label className={styles.muted} htmlFor="credential-id">
              credentialId
            </label>
            <input
              id="credential-id"
              className={styles.input}
              value={credentialId}
              onChange={event => setCredentialId(event.target.value)}
              placeholder="0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="submit"
              className={styles.button}
              disabled={lookup.status === "loading" || !credentialId.trim()}
            >
              {lookup.status === "loading" ? "Reading…" : "Read statusOf"}
            </button>
          </form>
          {lookup.status === "error" && (
            <ul className={styles.notes}>
              <li>{lookup.message}</li>
            </ul>
          )}
          {lookup.status === "done" && (
            <dl className={styles.facts}>
              <dt>Status</dt>
              <dd>
                <Badge tone={STATUS_TONE[lookup.record.status]}>{lookup.record.status}</Badge>
              </dd>
              {lookup.record.status !== "not_found" && (
                <>
                  <dt>Issued</dt>
                  <dd>{formatTime(lookup.record.issuedAt)}</dd>
                  <dt>Revoked</dt>
                  <dd>{formatTime(lookup.record.revokedAt)}</dd>
                  <dt>Issuer</dt>
                  <dd>
                    <code>{lookup.record.issuer}</code>
                  </dd>
                </>
              )}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

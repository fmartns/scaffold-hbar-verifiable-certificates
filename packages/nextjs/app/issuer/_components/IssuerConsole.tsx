"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AddEthereumChainParameter,
  IssuanceOutcome,
  IssuerConsoleSettings,
  IssuerFlowContext,
  RevocationOutcome,
  WalletTarget,
} from "@sh/sdk/hedera/wallet";
import { loadActivity, recordActivity } from "../_lib/activity";
import type { ActivityEntry } from "../_lib/activity";
import { createHttpIssuerBackend } from "../_lib/api";
import { useWallet } from "../_lib/useWallet";
import styles from "../issuer.module.css";
import { AuditPanel } from "./AuditPanel";
import { ErrorCallout } from "./ErrorCallout";
import { IssuePanel } from "./IssuePanel";
import { RevokePanel } from "./RevokePanel";

export function IssuerConsole({
  settings,
  target,
  addChain,
  fetchImpl,
  flowOptions,
}: {
  settings: IssuerConsoleSettings;
  target: WalletTarget | null;
  addChain: AddEthereumChainParameter | null;
  /** Injected in tests; defaults to the browser's fetch. */
  fetchImpl?: typeof fetch;
  /** Deadlines and clock of the flow, injected in tests. */
  flowOptions?: Partial<
    Pick<IssuerFlowContext, "now" | "sleep" | "receiptTimeoutMs" | "receiptPollMs" | "callTimeoutMs">
  >;
}) {
  const wallet = useWallet(target, addChain);
  const backend = useMemo(() => createHttpIssuerBackend(fetchImpl), [fetchImpl]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [audited, setAudited] = useState<{ credentialId: string; revocationSequence?: string; key: number } | null>(
    null,
  );
  const [revokePreset, setRevokePreset] = useState<{ credentialId: string; nonce: number } | null>(null);

  useEffect(() => setActivity(loadActivity()), []);

  const ready = settings.configured && settings.chainId !== null && settings.registryAddress !== null;

  const context = useCallback(
    (): IssuerFlowContext => ({
      provider: wallet.provider(),
      backend,
      chainId: settings.chainId ?? 0,
      registryAddress: settings.registryAddress ?? "",
      ...flowOptions,
    }),
    [wallet, backend, settings.chainId, settings.registryAddress, flowOptions],
  );

  const onIssued = (outcome: IssuanceOutcome) => {
    setActivity(
      recordActivity({
        kind: "issuance",
        credentialId: outcome.credentialId,
        at: outcome.hcs.recordedAt,
        network: outcome.hcs.network,
        hcsTransactionId: outcome.hcs.transactionId,
        hcsSequence: outcome.hcs.hcsRef.sequence,
        hcsHashscanUrl: outcome.hcs.hashscanUrl,
        registryTransactionHash: outcome.registration.transactionHash,
      }),
    );
    setAudited({ credentialId: outcome.credentialId, key: Date.now() });
  };

  const onRevoked = (outcome: RevocationOutcome) => {
    setActivity(
      recordActivity({
        kind: "revocation",
        credentialId: outcome.credentialId,
        at: outcome.hcs.recordedAt,
        network: outcome.hcs.network,
        hcsTransactionId: outcome.hcs.transactionId,
        hcsSequence: outcome.hcs.hcsRef.sequence,
        hcsHashscanUrl: outcome.hcs.hashscanUrl,
        registryTransactionHash: outcome.registration.transactionHash,
      }),
    );
    setAudited({
      credentialId: outcome.credentialId,
      revocationSequence: outcome.hcs.hcsRef.sequence,
      key: Date.now(),
    });
  };

  return (
    <>
      {!settings.configured && (
        <section className={styles.card} aria-labelledby="config-title">
          <h2 id="config-title">Not configured</h2>
          <p>
            The server cannot issue credentials until these variables are set in the root <code>.env</code>:
          </p>
          <ul className={styles.issueList}>
            {settings.issues.map(issue => (
              <li key={`${issue.variable}-${issue.message}`}>
                <code>{issue.variable}</code>: {issue.message}
              </li>
            ))}
          </ul>
          <p className={styles.fix}>
            Run <code>yarn setup</code>, <code>yarn hcs:topic</code> and deploy the registry, then restart. The
            environment dashboard (<code>/dashboard</code>) shows what is missing.
          </p>
        </section>
      )}

      <WalletBar wallet={wallet} target={target} settings={settings} />

      <div className={styles.grid}>
        <IssuePanel context={context} disabled={!ready} onIssued={onIssued} />
        <RevokePanel context={context} disabled={!ready} preset={revokePreset} onRevoked={onRevoked} />
      </div>

      {audited && (
        <AuditPanel
          credentialId={audited.credentialId}
          revocationSequence={audited.revocationSequence}
          refreshKey={audited.key}
          fetchAudit={backend.audit}
        />
      )}

      <section className={styles.card} aria-labelledby="activity-title">
        <h2 id="activity-title">Recent activity in this browser</h2>
        {activity.length === 0 ? (
          <p className={styles.muted}>
            Nothing yet. Only identifiers and evidence links are kept here, never personal data.
          </p>
        ) : (
          <ul className={styles.activity}>
            {activity.map(entry => (
              <li key={`${entry.kind}-${entry.credentialId}-${entry.hcsTransactionId}`}>
                <span className={`${styles.badge} ${entry.kind === "issuance" ? styles.ok : styles.warn}`}>
                  {entry.kind === "issuance" ? "Issued" : "Revoked"}
                </span>{" "}
                <code>{entry.credentialId}</code>{" "}
                <span className={styles.muted}>
                  {new Date(entry.at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC · {entry.network}
                </span>
                <div className={styles.links}>
                  {entry.hcsHashscanUrl ? (
                    <a href={entry.hcsHashscanUrl} target="_blank" rel="noreferrer">
                      HCS {entry.hcsTransactionId} ↗
                    </a>
                  ) : (
                    <code>HCS {entry.hcsTransactionId}</code>
                  )}
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setAudited({ credentialId: entry.credentialId, key: Date.now() })}
                  >
                    Audit
                  </button>
                  {entry.kind === "issuance" && (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setRevokePreset({ credentialId: entry.credentialId, nonce: Date.now() })}
                    >
                      Revoke…
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function WalletBar({
  wallet,
  target,
  settings,
}: {
  wallet: ReturnType<typeof useWallet>;
  target: WalletTarget | null;
  settings: IssuerConsoleSettings;
}) {
  return (
    <section className={`${styles.card} ${styles.walletBar}`} aria-label="Issuer wallet">
      <div>
        <strong>Issuer wallet</strong>{" "}
        {wallet.detection === "detecting" ? (
          <span className={`${styles.badge} ${styles.idle}`}>Detecting…</span>
        ) : wallet.detection === "none" ? (
          <span className={`${styles.badge} ${styles.error}`}>No wallet</span>
        ) : wallet.account ? (
          <span className={`${styles.badge} ${styles.ok}`}>Connected</span>
        ) : (
          <span className={`${styles.badge} ${styles.idle}`}>Disconnected</span>
        )}
        {wallet.account && (
          <>
            {" "}
            <code>{wallet.account}</code>
          </>
        )}
        <p className={styles.muted}>
          {wallet.detection === "none"
            ? "Install MetaMask (or HashPack in EVM mode): the wallet must be the issuer's registered signer."
            : `It signs the credential (EIP-712) and pays the registry transaction. Network: ${settings.network ?? "invalid"}${
                settings.registryAddress ? `, registry ${settings.registryAddress}` : ""
              }.`}
        </p>
      </div>
      <div className={styles.actions}>
        {wallet.detection === "available" && !wallet.account && (
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            onClick={wallet.connect}
            disabled={wallet.busy}
          >
            Connect wallet
          </button>
        )}
        {wallet.account && target && !wallet.onTarget && (
          <>
            <span className={`${styles.badge} ${styles.error}`}>
              Wrong network{wallet.chainId ? ` (chain ${Number(wallet.chainId)})` : ""}
            </span>
            <button type="button" className={styles.button} onClick={wallet.switchNetwork} disabled={wallet.busy}>
              Switch to {target.network}
            </button>
          </>
        )}
      </div>
      {wallet.error && <ErrorCallout error={wallet.error} />}
    </section>
  );
}

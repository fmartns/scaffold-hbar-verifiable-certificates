"use client";

import { useCallback, useEffect, useState } from "react";
import { formatWeibarsAsHbar, isTargetChain, walletAccountUrl } from "@sh/sdk/hedera/wallet";
import type { AddEthereumChainParameter, WalletTarget } from "@sh/sdk/hedera/wallet";
import type { EvmAccountLookup } from "@sh/sdk";
import styles from "../dashboard.module.css";
import { Badge } from "./StatusBadge";

/** EIP-1193 provider injected by MetaMask, HashPack (EVM mode), Rabby, … */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

type Detection = "detecting" | "none" | "available";

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;

function describeError(error: unknown): string {
  if (errorCode(error) === 4001) return "The request was rejected in the wallet.";
  if (errorCode(error) === -32002) return "A request is already pending: open the wallet to answer it.";
  return "The wallet did not complete the request.";
}

export function WalletPanel({
  target,
  addChain,
}: {
  target: WalletTarget | null;
  addChain: AddEthereumChainParameter | null;
}) {
  const [detection, setDetection] = useState<Detection>("detecting");
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [hederaAccount, setHederaAccount] = useState<EvmAccountLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onTarget = !!target && isTargetChain(target, chainId);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider) {
      setDetection("none");
      return;
    }
    setDetection("available");
    const onAccounts = (accounts: unknown) =>
      setAccount(Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null);
    const onChain = (id: unknown) => setChainId(typeof id === "string" ? id : null);

    // eth_accounts never prompts: it only reveals an existing connection.
    provider.request({ method: "eth_accounts" }).then(onAccounts, () => onAccounts([]));
    provider.request({ method: "eth_chainId" }).then(onChain, () => onChain(null));
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, []);

  useEffect(() => {
    setBalance(null);
    setHederaAccount(null);
    const provider = window.ethereum;
    if (!provider || !account || !onTarget) return;
    let cancelled = false;
    provider
      .request({ method: "eth_getBalance", params: [account, "latest"] })
      .then(value => !cancelled && setBalance(typeof value === "string" ? formatWeibarsAsHbar(value) : null))
      .catch(() => !cancelled && setBalance(null));
    fetch(`/api/wallet/account?address=${account}`)
      .then(response => response.json() as Promise<EvmAccountLookup>)
      .then(result => !cancelled && setHederaAccount(result))
      .catch(() => !cancelled && setHederaAccount({ status: "unavailable" }));
    return () => {
      cancelled = true;
    };
  }, [account, onTarget]);

  const run = useCallback(async (action: (provider: Eip1193Provider) => Promise<void>) => {
    const provider = window.ethereum;
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await action(provider);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = () =>
    run(async provider => {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      setAccount(Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null);
    });

  const switchNetwork = () =>
    run(async provider => {
      if (!target) return;
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target.chainIdHex }] });
      } catch (e) {
        // 4902: the wallet does not know this chain yet.
        if (errorCode(e) !== 4902 || !addChain) throw e;
        await provider.request({ method: "wallet_addEthereumChain", params: [addChain] });
      }
    });

  const addressUrl = account && onTarget && target ? walletAccountUrl(target, account) : null;

  return (
    <section className={styles.card} aria-labelledby="wallet-title">
      <h2 id="wallet-title">
        Wallet
        {detection === "available" && account ? (
          <Badge tone="ok">Connected</Badge>
        ) : (
          <Badge tone="idle">{detection === "detecting" ? "Detecting…" : "Disconnected"}</Badge>
        )}
      </h2>

      {detection === "none" && (
        <p className={styles.muted}>
          No EVM wallet detected in this browser. Install MetaMask (or use HashPack in EVM mode) to connect; the rest of
          the dashboard works without one.
        </p>
      )}

      {detection === "available" && !account && (
        <>
          <p className={styles.muted}>A wallet is available but not connected to this site.</p>
          <button type="button" className={`${styles.button} ${styles.primary}`} disabled={busy} onClick={connect}>
            Connect wallet
          </button>
        </>
      )}

      {detection === "available" && account && (
        <dl className={styles.facts}>
          <dt>Address</dt>
          <dd>
            <code>{account}</code>
          </dd>
          <dt>Network</dt>
          <dd>
            {target === null ? (
              <span className={styles.muted}>No valid target network is configured.</span>
            ) : onTarget ? (
              <Badge tone="ok">
                {target.network} (chain {target.chainId})
              </Badge>
            ) : (
              <>
                <Badge tone="error">Wrong network{chainId ? ` (chain ${Number(chainId)})` : ""}</Badge>{" "}
                <button type="button" className={styles.button} disabled={busy} onClick={switchNetwork}>
                  Switch to {target.network}
                </button>
              </>
            )}
          </dd>
          <dt>Account ID</dt>
          <dd>
            {!onTarget ? (
              <span className={styles.muted}>—</span>
            ) : hederaAccount === null ? (
              "…"
            ) : hederaAccount.status === "found" ? (
              <code>{hederaAccount.accountId}</code>
            ) : hederaAccount.status === "not_found" ? (
              <span className={styles.muted}>none yet: the address gets one when it first receives HBAR</span>
            ) : (
              <span className={styles.muted}>could not be resolved right now</span>
            )}
          </dd>
          <dt>Balance</dt>
          <dd>{onTarget ? balance === null ? "…" : `${balance} HBAR` : <span className={styles.muted}>—</span>}</dd>
          {addressUrl && (
            <>
              <dt>HashScan</dt>
              <dd>
                <a href={addressUrl} target="_blank" rel="noreferrer">
                  Account ↗
                </a>
              </dd>
            </>
          )}
        </dl>
      )}

      {error && (
        <ul className={styles.notes}>
          <li>{error}</li>
        </ul>
      )}
    </section>
  );
}

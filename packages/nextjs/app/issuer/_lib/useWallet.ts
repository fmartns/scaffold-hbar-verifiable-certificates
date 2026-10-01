"use client";

import { useCallback, useEffect, useState } from "react";
import { classifyIssuerError, isTargetChain } from "@sh/sdk/hedera/wallet";
import type { AddEthereumChainParameter, Eip1193Like, IssuerError, WalletTarget } from "@sh/sdk/hedera/wallet";

interface Eip1193Provider extends Eip1193Like {
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

const injected = () =>
  typeof window === "undefined" ? undefined : (window as unknown as { ethereum?: Eip1193Provider }).ethereum;

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? (error as { code: unknown }).code : undefined;

export type WalletDetection = "detecting" | "none" | "available";

/** The browser's EIP-1193 wallet: connection, account and chain, kept in sync with wallet events. */
export function useWallet(target: WalletTarget | null, addChain: AddEthereumChainParameter | null) {
  const [detection, setDetection] = useState<WalletDetection>("detecting");
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [error, setError] = useState<IssuerError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const provider = injected();
    if (!provider) {
      setDetection("none");
      return;
    }
    setDetection("available");
    const onAccounts = (accounts: unknown) =>
      setAccount(Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null);
    const onChain = (id: unknown) => setChainId(typeof id === "string" ? id : null);
    provider.request({ method: "eth_accounts" }).then(onAccounts, () => onAccounts([]));
    provider.request({ method: "eth_chainId" }).then(onChain, () => onChain(null));
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, []);

  const run = useCallback(async (action: (provider: Eip1193Provider) => Promise<void>) => {
    const provider = injected();
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await action(provider);
    } catch (e) {
      setError(classifyIssuerError(e));
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

  return {
    detection,
    account,
    chainId,
    onTarget: !!target && isTargetChain(target, chainId),
    error,
    busy,
    connect,
    switchNetwork,
    provider: injected,
  };
}

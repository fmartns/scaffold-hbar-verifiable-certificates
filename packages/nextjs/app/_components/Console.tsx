"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../_lib/api";
import type { ConsoleState } from "../_lib/api";
import styles from "../console.module.css";
import { IssuerPanel } from "./IssuerPanel";
import { PlatformPanel } from "./PlatformPanel";

/** The demo: an issuer, two holder wallets (ana, bob) and Platform B, all talking through Hedera. */
export function Console() {
  const [state, setState] = useState<ConsoleState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>) => {
      setBusy(label);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  if (!state) {
    return (
      <main className={styles.main}>
        {error ? <p className={styles.error}>{error} Run `yarn setup` to check the environment.</p> : <p>Loading…</p>}
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <h1>Course certificates on Hedera</h1>
      <p className={styles.muted}>
        AnonCreds credentials (holder-bound, selective disclosure, revocable) on the Hedera Verifiable Data Registry,
        each with a PDF stored on HCS-1. Network: <strong>{state.network}</strong>.
      </p>
      {busy && (
        <p className={styles.busy} role="status">
          {busy}…
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.columns}>
        <IssuerPanel state={state} run={run} />
        <PlatformPanel state={state} run={run} />
      </div>
    </main>
  );
}

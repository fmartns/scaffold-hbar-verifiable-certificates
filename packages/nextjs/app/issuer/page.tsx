import type { Metadata } from "next";
import { addEthereumChainParameter, isNetworkName, issuerConsoleSettings, walletTarget } from "@sh/sdk";
import { IssuerConsole } from "./_components/IssuerConsole";
import styles from "./issuer.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Issuer console · Verifiable Settlement" };

export default function IssuerPage() {
  const settings = issuerConsoleSettings(process.env);
  const network = settings.network && isNetworkName(settings.network) ? settings.network : null;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Issuer console</h1>
        <p className={styles.subtitle}>
          Issue and revoke verifiable credentials. Personal data is hashed in this browser and never sent; the evidence
          goes to HCS before the registry records it.
        </p>
      </header>
      <IssuerConsole
        settings={settings}
        target={network ? walletTarget(network) : null}
        addChain={network ? addEthereumChainParameter(network) : null}
      />
    </main>
  );
}

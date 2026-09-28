import Link from "next/link";
import { getSelectedNetwork, redactUrl } from "@sh/sdk";

// Read the environment on every request so the page reflects the running configuration.
export const dynamic = "force-dynamic";

export default function Home() {
  const network = getSelectedNetwork(process.env);

  return (
    <main style={{ margin: "0 auto", maxWidth: 720, padding: "2rem 1rem" }}>
      <h1>Verifiable Settlement</h1>
      <p>Target network</p>
      <dl>
        <dt>Network</dt>
        <dd>{network.name}</dd>
        <dt>Chain ID</dt>
        <dd>{network.chainId}</dd>
        <dt>JSON-RPC relay</dt>
        <dd>{redactUrl(network.rpcUrl)}</dd>
        <dt>Mirror Node</dt>
        <dd>{redactUrl(network.mirrorNodeUrl)}</dd>
      </dl>
      <p>
        <Link href="/dashboard">Check the environment health →</Link>
      </p>
    </main>
  );
}

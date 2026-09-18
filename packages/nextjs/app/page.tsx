import { getSelectedNetwork } from "@sh/sdk";

// Read the environment on every request so the page reflects the running configuration.
export const dynamic = "force-dynamic";

export default function Home() {
  const network = getSelectedNetwork(process.env);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", margin: "0 auto", maxWidth: 720, padding: "2rem 1rem" }}>
      <h1>Verifiable Settlement</h1>
      <p>Target network</p>
      <dl>
        <dt>Network</dt>
        <dd>{network.name}</dd>
        <dt>Chain ID</dt>
        <dd>{network.chainId}</dd>
        <dt>JSON-RPC relay</dt>
        <dd>{network.rpcUrl}</dd>
        <dt>Mirror Node</dt>
        <dd>{network.mirrorNodeUrl}</dd>
      </dl>
    </main>
  );
}

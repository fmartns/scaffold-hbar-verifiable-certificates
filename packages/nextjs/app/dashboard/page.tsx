import type { Metadata } from "next";
import { INTEGRATION_IDS, addEthereumChainParameter, checkHederaHealth, walletTarget } from "@sh/sdk";
import type { HederaHealthReport, IntegrationHealth } from "@sh/sdk";
import { CopyDiagnosticsButton } from "./_components/CopyDiagnosticsButton";
import { IntegrationRow } from "./_components/IntegrationRow";
import { RefreshButton } from "./_components/RefreshButton";
import { Badge, StatusBadge } from "./_components/StatusBadge";
import { WalletPanel } from "./_components/WalletPanel";
import styles from "./dashboard.module.css";

// Checked on every request: the page shows the running configuration, never a build-time snapshot.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Environment · Verifiable Settlement" };

const OVERALL: Record<HederaHealthReport["overall"], string> = {
  ok: "Every integration is healthy.",
  error: "At least one integration needs attention.",
  not_configured: "Healthy so far; some integrations are not configured yet.",
};

function Detail({ item, name }: { item: IntegrationHealth; name: string }) {
  const value = item.details[name];
  return value === undefined ? <span className={styles.muted}>—</span> : <code>{String(value)}</code>;
}

function OperatorCard({ report }: { report: HederaHealthReport }) {
  const { operator, integrations } = report;
  return (
    <section className={styles.card} aria-labelledby="operator-title">
      <h2 id="operator-title">
        Operator account
        <StatusBadge status={integrations.environment.status} transient={integrations.environment.transient} />
      </h2>
      <dl className={styles.facts}>
        <dt>Network</dt>
        <dd>
          {report.network ? (
            <>
              {report.network.name} <span className={styles.muted}>(chain {report.network.chainId})</span>
            </>
          ) : (
            <span className={styles.muted}>invalid HEDERA_NETWORK</span>
          )}
        </dd>
        <dt>Account</dt>
        <dd>
          {operator.accountId ? <code>{operator.accountId}</code> : <span className={styles.muted}>not set</span>}
        </dd>
        <dt>Balance</dt>
        <dd>
          {operator.balance ? `${operator.balance.hbar} HBAR` : <span className={styles.muted}>unknown</span>}
          {operator.minimumBalance && (
            <span className={styles.muted}> (minimum {operator.minimumBalance.hbar} HBAR)</span>
          )}
        </dd>
        <dt>Key</dt>
        <dd>
          {operator.keyVerified ? (
            <Badge tone="ok">matches the account</Badge>
          ) : (
            <span className={styles.muted}>not verified</span>
          )}
        </dd>
        <dt>HashScan</dt>
        <dd>
          {operator.hashscanUrl ? (
            <a href={operator.hashscanUrl} target="_blank" rel="noreferrer">
              Account ↗
            </a>
          ) : (
            <span className={styles.muted}>not available</span>
          )}
        </dd>
        {report.faucetUrl && (
          <>
            <dt>Test HBAR</dt>
            <dd>
              <a href={report.faucetUrl} target="_blank" rel="noreferrer">
                Testnet faucet ↗
              </a>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}

function DeploymentCard({ report }: { report: HederaHealthReport }) {
  const { registry, hcs } = report.integrations;
  const registryLink = registry.links[0];
  const topicLink = hcs.links[0];
  return (
    <section className={styles.card} aria-labelledby="deployment-title">
      <h2 id="deployment-title">Deployment</h2>
      <dl className={styles.facts}>
        <dt>CredentialRegistry</dt>
        <dd>
          <Detail item={registry} name="address" />{" "}
          <StatusBadge status={registry.status} transient={registry.transient} />
        </dd>
        <dt>Contract ID</dt>
        <dd>
          <Detail item={registry} name="contractId" />
          {registryLink && (
            <>
              {" · "}
              <a href={registryLink.url} target="_blank" rel="noreferrer">
                HashScan ↗
              </a>
            </>
          )}
        </dd>
        <dt>Bound topic</dt>
        <dd>
          <Detail item={registry} name="hcsTopic" />
        </dd>
        <dt>HCS topic</dt>
        <dd>
          <Detail item={hcs} name="topicId" /> <StatusBadge status={hcs.status} transient={hcs.transient} />
          {topicLink && (
            <>
              {" · "}
              <a href={topicLink.url} target="_blank" rel="noreferrer">
                HashScan ↗
              </a>
            </>
          )}
        </dd>
        <dt>Mirror Node</dt>
        <dd>
          {report.network ? <code>{report.network.mirrorNodeOrigin}</code> : <span className={styles.muted}>—</span>}
        </dd>
        <dt>JSON-RPC relay</dt>
        <dd>{report.network ? <code>{report.network.rpcOrigin}</code> : <span className={styles.muted}>—</span>}</dd>
      </dl>
    </section>
  );
}

function EnvironmentIssues({ report }: { report: HederaHealthReport }) {
  const { environment } = report;
  const items = [...(environment.ok ? [] : environment.issues), ...environment.warnings];
  if (items.length === 0) return null;
  return (
    <section className={styles.section} aria-labelledby="issues-title">
      <h2 id="issues-title">Environment validation</h2>
      <div className={styles.card}>
        <p className={styles.fix}>
          The same report as <code>yarn setup</code>, from the shared validator.
        </p>
        <ul className={styles.issues}>
          {items.map(item => (
            <li key={`${item.code}-${item.message}`}>
              <Badge tone={item.severity === "error" ? "error" : "warn"}>{item.code}</Badge> {item.message}
              <div className={styles.fix}>
                <strong>Fix:</strong> {item.remediation}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default async function DashboardPage() {
  const report = await checkHederaHealth(process.env);
  const target = report.network ? walletTarget(report.network.name) : null;
  const addChain = report.network ? addEthereumChainParameter(report.network.name) : null;

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div>
          <h1>Hedera environment</h1>
          <p className={styles.subtitle}>
            {OVERALL[report.overall]} Checked at{" "}
            {new Date(report.checkedAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC.
          </p>
        </div>
        <div className={styles.headerActions}>
          <StatusBadge status={report.overall} />
          <CopyDiagnosticsButton report={report} />
          <RefreshButton />
        </div>
      </header>

      <div className={styles.grid}>
        <OperatorCard report={report} />
        <WalletPanel target={target} addChain={addChain} />
        <DeploymentCard report={report} />
      </div>

      <section className={styles.section} aria-labelledby="integrations-title">
        <h2 id="integrations-title">Integrations</h2>
        <div className={styles.integrations}>
          {INTEGRATION_IDS.map(id => (
            <IntegrationRow key={id} item={report.integrations[id]} />
          ))}
        </div>
      </section>

      <EnvironmentIssues report={report} />
    </main>
  );
}

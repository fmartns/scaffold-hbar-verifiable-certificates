/**
 * End-to-end Testnet validation of the credential flow (#18): preflight, issuance (HCS consensus receipt first, then
 * `CredentialRegistry`), audit until consistent, deliberate re-issuance attempts, revocation, audit again.
 *
 * It composes the existing pieces and re-implements none of them: `validateHederaEnvironment` (preflight), the generated
 * manifest (`getDeployedContract`), the issuer flow (`runIssuance`/`runRevocation`, which fixes the D11 order) with the
 * console's server handlers as its backend (authorization + HCS publisher + credential envelope), and `auditCredential`
 * for the correlation. The operator's ECDSA key plays the issuer's wallet through {@link createRelayWallet}.
 *
 * Testnet only: mainnet and local are refused before anything is read. Nothing here prints or reads the terminal.
 */
import { Interface, keccak256, toUtf8Bytes } from "ethers";
import { auditCredential, DEFAULT_INDEX_BUDGET_SECONDS } from "../audit/audit";
import type { CredentialAuditContext } from "../audit/audit";
import { createCredentialAuditContext, loadCredentialAuditConfig } from "../audit/config";
import { callRegistry } from "../audit/registry";
import type { CredentialAuditReport, EvidenceStatus, TimelineEntry } from "../audit/types";
import { DeploymentNotFoundError, decodeContractError, deployCommand, getDeployedContract } from "../contracts";
import type { GeneratedDeployments } from "../contracts";
import { costLine, fetchUsdPerHbar, formatUsd } from "../cost";
import type { CostLine } from "../cost";
import { loadCredentialPublisherConfig } from "../credentials/config";
import type { CredentialPublisherConfig } from "../credentials/config";
import { IssuerFlowError, classifyIssuerError, findRevertData } from "../credentials/errors";
import type { IssuerError } from "../credentials/errors";
import { CREDENTIAL_SCHEMA_PRESETS } from "../credentials/fields";
import type { CredentialDraftInput } from "../credentials/fields";
import { runIssuance, runRevocation } from "../credentials/issuer-flow";
import type {
  CredentialPublishReceipt,
  Eip1193Like,
  IssuerBackend,
  IssuerFlowContext,
  RegistryTransaction,
} from "../credentials/issuer-flow";
import { decodeIssuerOfResult, encodeIssueCall, encodeIssuerOfCall } from "../credentials/registry-calls";
import { computeIssuerId } from "../credentials/schema";
import { handleCredentialStatus, handlePublishCredential } from "../credentials/server";
import type { ServerDeps } from "../credentials/server";
import { ENV as HEDERA_ENV, formatHbar, validateHederaEnvironment } from "../environment";
import type { EnvironmentValidation, EnvironmentVariables, HbarAmount, KeyInspector } from "../environment";
import { hashscanContractUrl, hashscanTopicUrl, hashscanTransactionUrl } from "../explorer";
import { ESTIMATED_FEE_USD } from "../hcs/cost";
import type { Hex } from "../hcs/envelope";
import type { HcsTransport } from "../hcs/publisher";
import { CredentialRegistryAbi } from "../../generated";
import { getSelectedNetwork, selectedNetworkName } from "../networks";
import type { HederaNetwork } from "../networks";
import { IssuerKeyError, resolveOperatorEvmKey } from "./issuer-key";
import { createRelayWallet } from "./relay-wallet";

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

export const VERIFY_TESTNET_DEFAULTS = {
  /** Issuer namespace used by the validation; registered on first use when the operator holds `ADMIN_ROLE`. */
  issuerName: "scaffold-hbar-verify",
  /** The issue asks for more than one run, so one lucky result is not mistaken for a working flow. */
  runs: 2,
  maxRuns: 5,
  /** `maxValidity` of the namespace when it is registered here, and the signature window of each credential. */
  issuerMaxValiditySeconds: 900n,
  validitySeconds: 600,
  /** Pause between audits while the Mirror Node is still indexing. */
  auditRetryMs: 5_000,
} as const;

/**
 * Upper bounds of the gas each registry call uses: Hardhat measures about 50k, 155k and 35k; the relay's estimates run
 * higher and the wallet adds 20% headroom. Hedera charges at least 80% of the gas limit, so the bound is the limit.
 */
export const ESTIMATED_GAS = { registerIssuer: 120_000n, issue: 350_000n, revoke: 100_000n } as const;

const REGISTRY = new Interface(CredentialRegistryAbi);
const ADMIN_ROLE = keccak256(toUtf8Bytes("ADMIN_ROLE"));
const TINYBARS_PER_HBAR = 100_000_000n;
const WEIBARS_PER_TINYBAR = 10_000_000_000n;

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export interface VerificationProblem {
  code: string;
  message: string;
  remediation: string;
}

export interface VerificationCost {
  hcsMessages: number;
  hcsPerMessage: CostLine;
  contractCalls: { call: "registerIssuer" | "issue" | "revoke"; count: number; gas: string }[];
  /** Relay gas price in weibars (1 tinybar = 10^10 weibars); `null` when it could not be read. */
  gasPriceWeibars: string | null;
  /** Upper bound of everything, in HBAR; `null` when the exchange rate or the gas price is unknown. */
  totalHbar: string | null;
  totalUsd: string | null;
  usdPerHbar: string | null;
}

export interface VerificationPlan {
  network: string;
  chainId: number;
  operatorId: string;
  balance: HbarAmount;
  registry: { address: string; source: "override" | "manifest"; contractId: string | null; hashscanUrl: string | null };
  topic: { id: string; hashscanUrl: string | null };
  issuer: {
    name: string;
    id: Hex;
    /** EVM address of the operator's ECDSA key: the issuer's signer and the submitter of every transaction. */
    signer: Hex;
    /** The namespace is not registered yet and will be, by the operator (who holds `ADMIN_ROLE`). */
    register: boolean;
  };
  runs: number;
  cost: VerificationCost;
}

/** What the run needs besides the plan. Never serialized: `env` holds the operator key. */
export interface VerificationSession {
  env: EnvironmentVariables;
  network: HederaNetwork;
  config: CredentialPublisherConfig;
  wallet: Eip1193Like & { address: Hex };
}

export type PlanResult =
  | { ok: true; plan: VerificationPlan; session: VerificationSession }
  | { ok: false; status: "invalid" | "unverified"; problem: VerificationProblem; environment?: EnvironmentValidation };

export interface VerifyDeps {
  fetch?: typeof fetch;
  inspectKey?: KeyInspector;
  /** Milliseconds since the epoch. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Overrides the HCS transport of the publisher (tests); no Hedera client is created then. */
  transport?: HcsTransport;
  manifest?: GeneratedDeployments;
  resolveIssuerKey?: (env: EnvironmentVariables, network: HederaNetwork) => Promise<string>;
  createWallet?: (privateKey: string, network: HederaNetwork) => Eip1193Like & { address: Hex };
  receiptPollMs?: number;
  auditRetryMs?: number;
  indexBudgetSeconds?: number;
}

export interface TxEvidence {
  transactionHash: Hex;
  hashscanUrl: string | null;
  mirrorUrl: string;
}

export interface HcsEvidenceRecord {
  transactionId: string;
  sequence: string;
  consensusTimestamp: string;
  hashscanUrl: string | null;
  mirrorMessageUrl: string;
}

export interface AuditSummary {
  evidence: EvidenceStatus;
  onChainStatus: CredentialAuditReport["onChain"]["status"];
  /** `consistent` with the expected on-chain status. */
  ok: boolean;
  attempts: number;
  elapsedMs: number;
  issuanceMatched: boolean;
  revocationMatched: boolean | null;
  findings: { code: string; severity: string }[];
  timeline: TimelineEntry[];
  /** The full report of the last attempt, as returned by `auditCredential`. */
  report: CredentialAuditReport;
}

export interface BlockedAttempt {
  attempt: "replay_signed_issuance" | "reissue_same_reference" | "revoke_again";
  description: string;
  /** The registry (or the flow, from `statusOf`) refused it as expected. */
  blocked: boolean;
  /** Error code it was refused with (a registry custom error name). */
  code: string | null;
  /** Nothing was published to HCS and no transaction was sent. */
  nothingPaid: boolean;
}

export interface RunEvidence {
  index: number;
  reference: string;
  credentialId: Hex | null;
  issuance?: { hcs: HcsEvidenceRecord; registry: TxEvidence; durationMs: number; steps: Record<string, number> };
  auditAfterIssuance?: AuditSummary;
  blockedAttempts: BlockedAttempt[];
  revocation?: { hcs: HcsEvidenceRecord; registry: TxEvidence; durationMs: number; steps: Record<string, number> };
  auditAfterRevocation?: AuditSummary;
  failure?: { stage: string; error: IssuerError };
  ok: boolean;
}

export interface VerificationResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  registration: (TxEvidence & { durationMs: number }) | null;
  registrationFailure?: IssuerError;
  runs: RunEvidence[];
}

export type ProgressSink = (line: string) => void;

// ---------------------------------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------------------------------

const problem = (code: string, message: string, remediation: string): VerificationProblem => ({
  code,
  message,
  remediation,
});
const refuse = (p: VerificationProblem, status: "invalid" | "unverified" = "invalid"): PlanResult => ({
  ok: false,
  status,
  problem: p,
});

/** Parses `--runs`: an integer from 1 to {@link VERIFY_TESTNET_DEFAULTS.maxRuns}. */
export function parseRuns(value: string | undefined): number | null {
  if (value === undefined) return VERIFY_TESTNET_DEFAULTS.runs;
  if (!/^\d+$/.test(value)) return null;
  const runs = Number(value);
  return runs >= 1 && runs <= VERIFY_TESTNET_DEFAULTS.maxRuns ? runs : null;
}

/** The validation's issuer namespace: lowercase letters, digits and dashes, 3 to 64 characters. */
export const isValidIssuerName = (name: string) => /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(name);

export function estimateVerificationCost(
  runs: number,
  register: boolean,
  gasPriceWeibars: bigint | null,
  usdPerHbar: number | null,
): VerificationCost {
  const contractCalls: VerificationCost["contractCalls"] = [
    ...(register ? [{ call: "registerIssuer" as const, count: 1, gas: ESTIMATED_GAS.registerIssuer.toString() }] : []),
    { call: "issue", count: runs, gas: ESTIMATED_GAS.issue.toString() },
    { call: "revoke", count: runs, gas: ESTIMATED_GAS.revoke.toString() },
  ];
  const hcsMessages = runs * 2;
  const totalGas = contractCalls.reduce((sum, c) => sum + BigInt(c.gas) * BigInt(c.count), 0n);
  let totalHbar: string | null = null;
  let totalUsd: string | null = null;
  if (gasPriceWeibars !== null && usdPerHbar) {
    const contractTinybars = (totalGas * gasPriceWeibars) / WEIBARS_PER_TINYBAR;
    const hcsTinybars = BigInt(
      Math.ceil(((hcsMessages * ESTIMATED_FEE_USD.publishMessage) / usdPerHbar) * Number(TINYBARS_PER_HBAR)),
    );
    const total = contractTinybars + hcsTinybars;
    totalHbar = formatHbar(total);
    totalUsd = formatUsd((Number(total) / Number(TINYBARS_PER_HBAR)) * usdPerHbar);
  }
  return {
    hcsMessages,
    hcsPerMessage: costLine(ESTIMATED_FEE_USD.publishMessage, usdPerHbar),
    contractCalls,
    gasPriceWeibars: gasPriceWeibars === null ? null : gasPriceWeibars.toString(),
    totalHbar,
    totalUsd,
    usdPerHbar: usdPerHbar ? usdPerHbar.toFixed(4) : null,
  };
}

/**
 * Everything checked before anything is paid: the network (Testnet only), the environment (`validateHederaEnvironment`),
 * the registry (env override or generated manifest), the HCS topic, the operator's ECDSA key and the issuer namespace,
 * plus the estimated cost.
 */
export async function planVerification(
  env: EnvironmentVariables,
  options: VerifyDeps & { runs?: number; issuerName?: string } = {},
): Promise<PlanResult> {
  const runs = options.runs ?? VERIFY_TESTNET_DEFAULTS.runs;
  const issuerName = options.issuerName ?? VERIFY_TESTNET_DEFAULTS.issuerName;

  let networkName: string | null = null;
  try {
    networkName = selectedNetworkName(env);
  } catch {
    networkName = null; // reported by validateHederaEnvironment below
  }
  if (networkName === "mainnet") {
    return refuse(
      problem(
        "MAINNET_REFUSED",
        "HEDERA_NETWORK is mainnet. The Testnet validation never runs on mainnet: it would spend real HBAR on throwaway credentials.",
        "Set HEDERA_NETWORK=testnet (or leave it empty) with a Testnet operator account.",
      ),
    );
  }
  if (networkName === "local") {
    return refuse(
      problem(
        "NOT_TESTNET",
        "HEDERA_NETWORK is local. This command validates the real Hedera Testnet; the local flow is covered by `yarn test`.",
        "Set HEDERA_NETWORK=testnet (or leave it empty).",
      ),
    );
  }

  const environment = await validateHederaEnvironment(env, {
    fetch: options.fetch,
    inspectKey: options.inspectKey,
    ...(options.now && { now: () => new Date(options.now!()) }),
  });
  if (!environment.ok) {
    const first = environment.issues[0];
    return {
      ok: false,
      status: environment.status,
      environment,
      problem: problem(
        first?.code ?? "ENVIRONMENT_INVALID",
        first?.message ?? "The Hedera environment is not valid.",
        "Fix the issues listed above (`yarn setup` shows the same report).",
      ),
    };
  }
  const network = getSelectedNetwork(env);

  let registry;
  try {
    registry = getDeployedContract("CredentialRegistry", "testnet", {
      override: env.HEDERA_CREDENTIAL_REGISTRY_ADDRESS,
      manifest: options.manifest,
    });
  } catch (error) {
    if (error instanceof DeploymentNotFoundError) {
      return refuse(
        problem(
          "REGISTRY_NOT_DEPLOYED",
          "No CredentialRegistry is configured for Testnet (HEDERA_CREDENTIAL_REGISTRY_ADDRESS is empty and packages/sdk/generated has no Testnet deployment).",
          `Create the topic first (\`yarn hcs:topic --write\`), then deploy with \`${deployCommand("testnet")}\`.`,
        ),
      );
    }
    return refuse(
      problem(
        "REGISTRY_ADDRESS_INVALID",
        "HEDERA_CREDENTIAL_REGISTRY_ADDRESS is not a valid, non-zero EVM address.",
        "Set it to the address printed by the deploy, or leave it empty to use packages/sdk/generated.",
      ),
    );
  }
  const effectiveEnv: EnvironmentVariables = { ...env, HEDERA_CREDENTIAL_REGISTRY_ADDRESS: registry.address };

  const loaded = loadCredentialPublisherConfig(effectiveEnv);
  if (!loaded.ok) {
    const topicMissing = loaded.issues.some(i => i.variable === "HEDERA_HCS_TOPIC_ID");
    return refuse(
      problem(
        topicMissing ? "TOPIC_NOT_CONFIGURED" : "NOT_CONFIGURED",
        loaded.issues.map(i => i.message).join(" "),
        topicMissing
          ? "Create the evidence topic with `yarn hcs:topic --write` (then deploy the registry for it)."
          : `Set ${[...new Set(loaded.issues.map(i => i.variable))].join(", ")} in .env.`,
      ),
    );
  }
  const config = loaded.config;

  let privateKey: string;
  try {
    privateKey = await (options.resolveIssuerKey ?? ((e, n) => resolveOperatorEvmKey(e, n, { fetch: options.fetch })))(
      env,
      network,
    );
  } catch (error) {
    if (error instanceof IssuerKeyError) return refuse(problem(error.code, error.message, error.remediation));
    return refuse(
      problem("ISSUER_KEY_UNRESOLVED", "The operator key could not be resolved.", "Run `yarn setup` to diagnose."),
    );
  }
  const wallet = (
    options.createWallet ??
    ((key, net) =>
      createRelayWallet({ privateKey: key, rpcUrl: net.rpcUrl, chainId: net.chainId, fetch: options.fetch }))
  )(privateKey, network);

  const issuerId = computeIssuerId(issuerName);
  const read = { network, registryAddress: config.registryAddress, fetch: options.fetch };
  let register = false;
  try {
    const cfg = decodeIssuerOfResult(await callRegistry(read, encodeIssuerOfCall(issuerId)));
    if (!cfg.registered) {
      const [isAdmin] = REGISTRY.decodeFunctionResult(
        "hasRole",
        await callRegistry(read, REGISTRY.encodeFunctionData("hasRole", [ADMIN_ROLE, wallet.address])),
      );
      if (!isAdmin) {
        return refuse(
          problem(
            "ISSUER_NOT_REGISTERED",
            `The issuer namespace "${issuerName}" is not registered, and the operator (${wallet.address}) does not hold ADMIN_ROLE to register it.`,
            `Have the registry admin call registerIssuer(${issuerId}, ${wallet.address}, ${VERIFY_TESTNET_DEFAULTS.issuerMaxValiditySeconds}), or pass --issuer <a namespace whose signer is the operator>.`,
          ),
        );
      }
      register = true;
    } else if (cfg.signer !== wallet.address) {
      return refuse(
        problem(
          "ISSUER_SIGNER_MISMATCH",
          `The issuer namespace "${issuerName}" is registered with signer ${cfg.signer}, not the operator (${wallet.address}).`,
          "Pass --issuer <another namespace>, or rotate that namespace's signer to the operator.",
        ),
      );
    } else if (!cfg.active) {
      return refuse(
        problem(
          "ISSUER_INACTIVE",
          `The issuer namespace "${issuerName}" is inactive.`,
          "Ask the registry admin to reactivate it (setIssuerActive), or pass --issuer <another namespace>.",
        ),
      );
    } else if (cfg.maxValidity < BigInt(VERIFY_TESTNET_DEFAULTS.validitySeconds)) {
      return refuse(
        problem(
          "ISSUER_MAX_VALIDITY_TOO_SHORT",
          `The issuer namespace "${issuerName}" allows signature windows of ${cfg.maxValidity} s; the validation signs ${VERIFY_TESTNET_DEFAULTS.validitySeconds} s.`,
          "Ask the registry admin to raise it (setIssuerMaxValidity), or pass --issuer <another namespace>.",
        ),
      );
    }
  } catch {
    return refuse(
      problem(
        "REGISTRY_UNREADABLE",
        `The CredentialRegistry at ${config.registryAddress} could not be read over the JSON-RPC relay.`,
        "Retry in a few seconds; if it persists, check HEDERA_RPC_URL and the registry address (open /dashboard).",
      ),
      "unverified",
    );
  }

  let gasPrice: bigint | null = null;
  try {
    const answer = await wallet.request({ method: "eth_gasPrice" });
    gasPrice = typeof answer === "string" && /^0x[0-9a-fA-F]+$/.test(answer) ? BigInt(answer) : null;
  } catch {
    gasPrice = null;
  }
  const cost = estimateVerificationCost(runs, register, gasPrice, await fetchUsdPerHbar(network, options.fetch));

  return {
    ok: true,
    plan: {
      network: network.name,
      chainId: network.chainId,
      operatorId: env[HEDERA_ENV.OPERATOR_ID]?.trim() ?? environment.accountId,
      balance: environment.balance,
      registry: {
        address: registry.address,
        source: registry.source,
        contractId: registry.contractId,
        hashscanUrl: hashscanContractUrl(network, registry.contractId ?? registry.address),
      },
      topic: { id: config.topicId, hashscanUrl: hashscanTopicUrl(network, config.topicId) },
      issuer: { name: issuerName, id: issuerId, signer: wallet.address, register },
      runs,
      cost,
    },
    session: { env: effectiveEnv, network, config, wallet },
  };
}

/** Whether the balance covers the estimate; `null` when the estimate is unknown. */
export function balanceCovers(plan: VerificationPlan): boolean | null {
  if (!plan.cost.totalHbar) return null;
  const [whole, fraction = ""] = plan.cost.totalHbar.split(".");
  const needed = BigInt(whole) * TINYBARS_PER_HBAR + BigInt(fraction.padEnd(8, "0").slice(0, 8));
  return BigInt(plan.balance.tinybars) >= needed;
}

// ---------------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------------

/** The run id: the start time, compact (`20261001T124500Z`). Unique per run and readable in a file name. */
export const runIdOf = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** The throwaway credential of one run: a course completion with a synthetic holder, unique per run id and index. */
export function verificationDraftInput(
  issuerName: string,
  runId: string,
  index: number,
  nowMs: number,
): CredentialDraftInput {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  return {
    issuerName,
    schema: CREDENTIAL_SCHEMA_PRESETS[1].descriptor,
    reference: `VERIFY-${runId}-${index}`,
    subjectIdType: "email",
    subjectIdValue: `holder.${runId.toLowerCase()}.${index}@example.com`,
    issuedOn: today,
    expiresOn: "",
    claims: {
      courseCode: "HEDERA-TESTNET",
      courseName: "Testnet validation of the credential flow",
      completedOn: today,
      hours: "1",
      grade: "pass",
    },
    validitySeconds: VERIFY_TESTNET_DEFAULTS.validitySeconds,
  };
}

/** The issuer flow's backend, in process: the same handlers the console's API routes call. */
export function createInProcessBackend(deps: ServerDeps): IssuerBackend & { publications: () => number } {
  let publications = 0;
  return {
    publications: () => publications,
    async publish(request) {
      const response = await handlePublishCredential(request, deps);
      if (!response.body.ok) throw new IssuerFlowError(response.body.error);
      publications += 1;
      return response.body.value;
    },
    async status(credentialId) {
      const response = await handleCredentialStatus(credentialId, deps);
      if (!response.body.ok) throw new IssuerFlowError(response.body.error);
      return response.body.value;
    },
  };
}

const mirrorTxUrl = (network: HederaNetwork, hash: string) =>
  `${network.mirrorNodeUrl}/api/v1/contracts/results/${hash}`;

function txEvidence(network: HederaNetwork, tx: RegistryTransaction, onChainHashscan?: string | null): TxEvidence {
  return {
    transactionHash: tx.transactionHash,
    hashscanUrl: onChainHashscan ?? hashscanTransactionUrl(network, tx.transactionHash),
    mirrorUrl: mirrorTxUrl(network, tx.transactionHash),
  };
}

const hcsEvidence = (receipt: CredentialPublishReceipt): HcsEvidenceRecord => ({
  transactionId: receipt.transactionId,
  sequence: receipt.hcsRef.sequence,
  consensusTimestamp: receipt.consensusTimestamp,
  hashscanUrl: receipt.hashscanUrl,
  mirrorMessageUrl: receipt.mirrorMessageUrl,
});

/**
 * Audits until the report settles: while the Mirror Node has not indexed the facts (`pending_index`) or could not be
 * read (`unavailable`), asks again, up to the index budget plus one poll. The report's verdict is never overridden.
 */
export async function auditUntilSettled(
  credentialId: string,
  ctx: CredentialAuditContext,
  expected: "issued" | "revoked",
  options: { now: () => number; sleep: (ms: number) => Promise<void>; retryMs: number; revocationHcsSequence?: bigint },
): Promise<AuditSummary> {
  const started = options.now();
  const budgetMs = (ctx.indexBudgetSeconds ?? DEFAULT_INDEX_BUDGET_SECONDS) * 1000 + (ctx.pollTimeoutMs ?? 0);
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const report = await auditCredential(credentialId, ctx, {
      ...(options.revocationHcsSequence !== undefined && { revocationHcsSequence: options.revocationHcsSequence }),
    });
    const elapsedMs = options.now() - started;
    const settling = report.evidence === "pending_index" || report.evidence === "unavailable";
    if (!settling || elapsedMs >= budgetMs) {
      return {
        evidence: report.evidence,
        onChainStatus: report.onChain.status,
        ok: report.evidence === "consistent" && report.onChain.status === expected,
        attempts,
        elapsedMs,
        issuanceMatched: report.issuance?.matched ?? false,
        revocationMatched: report.revocation ? report.revocation.matched : null,
        findings: report.findings.map(f => ({ code: f.code, severity: f.severity })),
        timeline: report.timeline,
        report,
      };
    }
    await options.sleep(options.retryMs);
  }
}

/**
 * `classifyIssuerError`, plus the errors outside the issuer taxonomy (e.g. `IssuerAlreadyRegistered`,
 * `AccessControlUnauthorizedAccount` on `registerIssuer`), named from the generated error table.
 */
function classifyRegistryFailure(error: unknown): IssuerError {
  const classified = classifyIssuerError(error);
  if (classified.category !== "unknown") return classified;
  const decoded = decodeContractError(findRevertData(error));
  if (!decoded) return classified;
  return {
    ...classified,
    category: "contract_rejected",
    code: decoded.name,
    title: "The registry refused the transaction",
    message: `CredentialRegistry reverted with ${decoded.signature}.`,
    remediation: "Check the issuer namespace and the operator's role in the registry, then run again.",
  };
}

/** Sends a registry transaction from the wallet (dry-run first) and waits for its receipt. Throws `IssuerFlowError`. */
async function sendRegistryTransaction(
  wallet: Eip1193Like & { address: Hex },
  to: string,
  data: string,
  timing: { now: () => number; sleep: (ms: number) => Promise<void>; pollMs: number; timeoutMs: number },
): Promise<RegistryTransaction> {
  const tx = { from: wallet.address, to, data };
  try {
    await wallet.request({ method: "eth_call", params: [tx, "latest"] });
    const hash = String(await wallet.request({ method: "eth_sendTransaction", params: [tx] })).toLowerCase() as Hex;
    const started = timing.now();
    for (;;) {
      const receipt = (await wallet.request({ method: "eth_getTransactionReceipt", params: [hash] })) as {
        status?: unknown;
        blockNumber?: unknown;
      } | null;
      if (receipt && (receipt.status === "0x1" || receipt.status === 1)) {
        return { transactionHash: hash, blockNumber: String(receipt.blockNumber ?? ""), from: wallet.address };
      }
      if (receipt) {
        throw new IssuerFlowError({
          ...classifyIssuerError(new Error("CONTRACT_REVERT_EXECUTED")),
          transactionHash: hash,
        });
      }
      if (timing.now() - started >= timing.timeoutMs) {
        throw new IssuerFlowError({
          category: "timeout",
          code: "TIMEOUT",
          title: "Timed out",
          message: "The registry transaction was not confirmed in time.",
          remediation: "Check it on HashScan before running again.",
          transactionHash: hash,
        });
      }
      await timing.sleep(timing.pollMs);
    }
  } catch (error) {
    throw error instanceof IssuerFlowError ? error : new IssuerFlowError(classifyRegistryFailure(error));
  }
}

async function expectBlocked(
  attempt: BlockedAttempt["attempt"],
  description: string,
  expectedCodes: string[],
  run: () => Promise<unknown>,
  paid: () => boolean,
): Promise<BlockedAttempt> {
  try {
    await run();
    return { attempt, description, blocked: false, code: null, nothingPaid: !paid() };
  } catch (error) {
    const code = classifyIssuerError(error).code;
    return { attempt, description, blocked: expectedCodes.includes(code), code, nothingPaid: !paid() };
  }
}

const stepTimer = (now: () => number) => {
  const steps: Record<string, number> = {};
  const started: Record<string, number> = {};
  return {
    steps,
    on: (event: { step: string; state: "active" | "done" }) => {
      if (event.state === "active") started[event.step] = now();
      else if (started[event.step] !== undefined) steps[event.step] = now() - started[event.step];
    },
  };
};

const errorLine = (e: IssuerError) =>
  `[${e.code}] ${e.message}${e.transactionId ? ` (HCS ${e.transactionId})` : ""}${e.transactionHash ? ` (tx ${e.transactionHash})` : ""}`;

/** Runs the validation described by `plan`. Spends HBAR: call it only after the person agreed (or `--yes`). */
export async function runVerification(
  plan: VerificationPlan,
  session: VerificationSession,
  deps: VerifyDeps = {},
  progress: ProgressSink = () => undefined,
): Promise<VerificationResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const startedMs = now();
  const { network, wallet, config } = session;
  const serverDeps: ServerDeps = {
    env: session.env,
    fetch: deps.fetch,
    transport: deps.transport,
    now: () => new Date(now()),
  };
  const backend = createInProcessBackend(serverDeps);
  const flow: IssuerFlowContext = {
    provider: wallet,
    backend,
    chainId: network.chainId,
    registryAddress: config.registryAddress,
    now,
    sleep,
    receiptPollMs: deps.receiptPollMs,
  };
  const auditCtx = createCredentialAuditContext(loadCredentialAuditConfig(session.env), {
    fetch: deps.fetch,
    now,
    sleep,
    indexBudgetSeconds: deps.indexBudgetSeconds,
  });
  const auditTiming = { now, sleep, retryMs: deps.auditRetryMs ?? VERIFY_TESTNET_DEFAULTS.auditRetryMs };
  const finish = (
    partial: Omit<VerificationResult, "startedAt" | "finishedAt" | "durationMs">,
  ): VerificationResult => ({
    ...partial,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    durationMs: now() - startedMs,
  });

  let registration: VerificationResult["registration"] = null;
  if (plan.issuer.register) {
    progress(`Registering the issuer namespace "${plan.issuer.name}" (signer ${plan.issuer.signer})`);
    const started = now();
    try {
      const tx = await sendRegistryTransaction(
        wallet,
        config.registryAddress,
        REGISTRY.encodeFunctionData("registerIssuer", [
          plan.issuer.id,
          plan.issuer.signer,
          VERIFY_TESTNET_DEFAULTS.issuerMaxValiditySeconds,
        ]),
        { now, sleep, pollMs: deps.receiptPollMs ?? 1_500, timeoutMs: 90_000 },
      );
      registration = { ...txEvidence(network, tx), durationMs: now() - started };
      progress(`  ok    registerIssuer ${tx.transactionHash}`);
    } catch (error) {
      const issuerError = classifyRegistryFailure(error);
      progress(`  x     ${errorLine(issuerError)}`);
      return finish({ ok: false, registration: null, registrationFailure: issuerError, runs: [] });
    }
  }

  const runId = runIdOf(startedMs);
  const runs: RunEvidence[] = [];
  for (let index = 1; index <= plan.runs; index++) {
    const input = verificationDraftInput(plan.issuer.name, runId, index, now());
    const evidence: RunEvidence = {
      index,
      reference: input.reference,
      credentialId: null,
      blockedAttempts: [],
      ok: false,
    };
    runs.push(evidence);
    let stage = "issuance";
    progress(`Run ${index}/${plan.runs}: credential ${input.reference}`);
    try {
      const issueTimer = stepTimer(now);
      const issueStarted = now();
      const issued = await runIssuance(input, flow, issueTimer.on);
      evidence.credentialId = issued.credentialId;
      evidence.issuance = {
        hcs: hcsEvidence(issued.hcs),
        registry: txEvidence(network, issued.registration),
        durationMs: now() - issueStarted,
        steps: issueTimer.steps,
      };
      progress(
        `  ok    HCS issuance evidence ${config.topicId}#${issued.hcs.hcsRef.sequence} (${issued.hcs.transactionId})`,
      );
      progress(`  ok    issue() ${issued.registration.transactionHash}`);

      stage = "audit after issuance";
      const afterIssue = await auditUntilSettled(issued.credentialId, auditCtx, "issued", auditTiming);
      evidence.auditAfterIssuance = afterIssue;
      if (afterIssue.report.issuance?.onChain?.hashscanUrl) {
        evidence.issuance.registry.hashscanUrl = afterIssue.report.issuance.onChain.hashscanUrl;
      }
      progress(
        `  ${afterIssue.ok ? "ok" : "x "}    audit: ${afterIssue.evidence}, on-chain ${afterIssue.onChainStatus} (${afterIssue.attempts} attempt(s))`,
      );

      stage = "re-issuance attempts";
      const publishedBefore = backend.publications();
      const replay = await expectBlocked(
        "replay_signed_issuance",
        "Replay the exact signed issuance with its HCS reference (eth_call of issue)",
        ["AlreadyIssued"],
        () =>
          wallet.request({
            method: "eth_call",
            params: [
              {
                from: wallet.address,
                to: config.registryAddress,
                data: encodeIssueCall(issued.event, issued.signature, issued.hcs.hcsRef),
              },
              "latest",
            ],
          }),
        () => backend.publications() !== publishedBefore,
      );
      const reissue = await expectBlocked(
        "reissue_same_reference",
        "Issue the same reference again with a fresh holder salt (full issuer flow)",
        ["ConflictingCredential", "AlreadyIssued"],
        () => runIssuance(input, flow),
        () => backend.publications() !== publishedBefore,
      );
      evidence.blockedAttempts.push(replay, reissue);
      for (const attempt of [replay, reissue]) {
        progress(
          `  ${attempt.blocked && attempt.nothingPaid ? "ok" : "x "}    blocked ${attempt.attempt}: ${attempt.code ?? "NOT BLOCKED"}`,
        );
      }

      stage = "revocation";
      const revokeTimer = stepTimer(now);
      const revokeStarted = now();
      const revoked = await runRevocation(
        { credentialId: issued.credentialId, reason: "superseded" },
        flow,
        revokeTimer.on,
      );
      evidence.revocation = {
        hcs: hcsEvidence(revoked.hcs),
        registry: txEvidence(network, revoked.registration),
        durationMs: now() - revokeStarted,
        steps: revokeTimer.steps,
      };
      progress(
        `  ok    HCS revocation evidence ${config.topicId}#${revoked.hcs.hcsRef.sequence} (${revoked.hcs.transactionId})`,
      );
      progress(`  ok    revoke() ${revoked.registration.transactionHash}`);

      stage = "audit after revocation";
      const afterRevoke = await auditUntilSettled(issued.credentialId, auditCtx, "revoked", {
        ...auditTiming,
        revocationHcsSequence: BigInt(revoked.hcs.hcsRef.sequence),
      });
      evidence.auditAfterRevocation = afterRevoke;
      if (afterRevoke.report.revocation?.onChain?.hashscanUrl) {
        evidence.revocation.registry.hashscanUrl = afterRevoke.report.revocation.onChain.hashscanUrl;
      }
      progress(
        `  ${afterRevoke.ok ? "ok" : "x "}    audit: ${afterRevoke.evidence}, on-chain ${afterRevoke.onChainStatus} (${afterRevoke.attempts} attempt(s))`,
      );

      stage = "revoke again";
      const publishedAfterRevoke = backend.publications();
      const revokeAgain = await expectBlocked(
        "revoke_again",
        "Revoke the already revoked credential again (full issuer flow)",
        ["AlreadyRevoked"],
        () => runRevocation({ credentialId: issued.credentialId, reason: "superseded" }, flow),
        () => backend.publications() !== publishedAfterRevoke,
      );
      evidence.blockedAttempts.push(revokeAgain);
      progress(
        `  ${revokeAgain.blocked && revokeAgain.nothingPaid ? "ok" : "x "}    blocked revoke_again: ${revokeAgain.code ?? "NOT BLOCKED"}`,
      );

      evidence.ok = afterIssue.ok && afterRevoke.ok && evidence.blockedAttempts.every(a => a.blocked && a.nothingPaid);
    } catch (error) {
      const issuerError = classifyIssuerError(error);
      evidence.failure = { stage, error: issuerError };
      progress(`  x     ${stage}: ${errorLine(issuerError)}`);
    }
    if (!evidence.ok) break;
  }

  return finish({ ok: runs.length === plan.runs && runs.every(r => r.ok), registration, runs });
}

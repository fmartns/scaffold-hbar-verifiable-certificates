/**
 * The template's contracts as recorded by the ABI/address codegen (#24) in `packages/sdk/generated/`: typed ABIs, the
 * per-network deployment manifest and the custom-error table. Nothing else may hold a contract ABI or address literal.
 *
 * Client-safe: it depends only on ethers, `networks.ts`, `explorer.ts` and the generated files, so the browser imports it
 * as `@sh/sdk/hedera/contracts` (never the package root, which pulls in the Hedera SDK).
 */
import { ErrorFragment, Interface, getAddress } from "ethers";
import { contractAbis, contractErrors, deployments } from "../generated";
import type { ContractName, DeploymentRecord, GeneratedDeployments } from "../generated";
import { hashscanContractUrl } from "./explorer";
import { HARDHAT_NETWORK_NAMES, NETWORKS } from "./networks";
import type { HederaNetwork, HederaNetworkName } from "./networks";

export { contractAbis, deployments };
export type { ContractName, DeploymentRecord, GeneratedDeployments };

export interface DeployedContract<N extends ContractName = ContractName> {
  name: N;
  network: HederaNetworkName;
  /** Lowercase EVM address. */
  address: `0x${string}`;
  abi: (typeof contractAbis)[N];
  /** `override`: an explicitly configured address (e.g. an environment variable) took precedence over the manifest. */
  source: "manifest" | "override";
  /** Hedera contract id (`0.0.x`) when the manifest has it. */
  contractId: string | null;
  /** HashScan page of the contract; `null` on a network without a public explorer. */
  hashscanUrl: string | null;
  /** The manifest entry; `null` for an override. */
  deployment: DeploymentRecord | null;
}

export function deployCommand(network: HederaNetworkName): string {
  return `yarn deploy --network ${HARDHAT_NETWORK_NAMES[network]}`;
}

/** The same text for the hook, the dashboard and `yarn setup`: which network, which chain, which command. */
export function missingDeploymentMessage(name: ContractName, network: HederaNetworkName): string {
  return (
    `No ${name} deployment for ${network} (chain ${NETWORKS[network].chainId}) in packages/sdk/generated. ` +
    `Run \`${deployCommand(network)}\`.`
  );
}

export class DeploymentNotFoundError extends Error {
  readonly code = "DEPLOYMENT_NOT_FOUND";
  readonly contract: ContractName;
  readonly network: HederaNetworkName;
  constructor(contract: ContractName, network: HederaNetworkName) {
    super(missingDeploymentMessage(contract, network));
    this.name = "DeploymentNotFoundError";
    this.contract = contract;
    this.network = network;
  }
}

/** The manifest entry of a contract on a network, or `null` when it was never deployed there by this template. */
export function findDeployment(
  name: ContractName,
  network: HederaNetworkName,
  manifest: GeneratedDeployments = deployments,
): DeploymentRecord | null {
  return manifest[network]?.[name] ?? null;
}

const isNonZeroAddress = (value: string) => {
  try {
    return !/^0x0{40}$/i.test(getAddress(value));
  } catch {
    return false;
  }
};

/**
 * Address, ABI and links of a deployed contract. An `override` address (non-empty) wins over the manifest, so an
 * explicit configuration is never silently replaced; it must be a valid, non-zero EVM address.
 *
 * @throws DeploymentNotFoundError when there is neither an override nor a manifest entry.
 */
export function getDeployedContract<N extends ContractName>(
  name: N,
  network: HederaNetworkName,
  options: { override?: string | null; manifest?: GeneratedDeployments } = {},
): DeployedContract<N> {
  const net = NETWORKS[network];
  const override = options.override?.trim();
  if (override) {
    if (!isNonZeroAddress(override))
      throw new Error(`The configured ${name} address is not a valid, non-zero EVM address.`);
    const address = override.toLowerCase() as `0x${string}`;
    return {
      name,
      network,
      address,
      abi: contractAbis[name],
      source: "override",
      contractId: null,
      hashscanUrl: hashscanContractUrl(net, address),
      deployment: null,
    };
  }
  const deployment = findDeployment(name, network, options.manifest);
  if (!deployment) throw new DeploymentNotFoundError(name, network);
  return {
    name,
    network,
    address: deployment.address,
    abi: contractAbis[name],
    source: "manifest",
    contractId: deployment.contractId,
    hashscanUrl: hashscanContractUrl(net, deployment.contractId ?? deployment.address),
    deployment,
  };
}

/** One line per contract of the template: where it is deployed on `network`, or the command that deploys it. */
export function describeDeployments(
  network: HederaNetworkName,
  manifest: GeneratedDeployments = deployments,
): string[] {
  return (Object.keys(contractAbis) as ContractName[]).sort().map(name => {
    const d = findDeployment(name, network, manifest);
    if (!d) return `${name}: ${missingDeploymentMessage(name, network)}`;
    const url = hashscanContractUrl(NETWORKS[network], d.contractId ?? d.address);
    return `${name}: ${d.address}${d.contractId ? ` (${d.contractId})` : ""}${url ? ` ${url}` : ""}`;
  });
}

/**
 * Hedera contract id (`0.0.x`) of an EVM address on the Mirror Node, or `null` when unknown. The Mirror Node indexes a
 * new contract a few seconds after consensus, so `null` right after a deployment means "not yet", not "absent".
 */
export async function lookupContractId(
  network: HederaNetwork,
  address: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1/contracts/${address}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { contract_id?: unknown };
    return typeof body.contract_id === "string" && /^\d+\.\d+\.\d+$/.test(body.contract_id) ? body.contract_id : null;
  } catch {
    return null;
  }
}

export interface DecodedContractError {
  selector: `0x${string}`;
  name: string;
  /** e.g. `AlreadyIssued(bytes32)` */
  signature: string;
  /** Contracts of this template that declare (or inherit) the error. */
  contracts: readonly ContractName[];
  args: unknown[];
}

/**
 * Decodes revert data against every custom error of the template's ABIs, without a hand-maintained table. `null` when
 * the data is not one of them (an empty revert, a `require` string, a panic, or another contract's error).
 */
export function decodeContractError(data: string | null | undefined): DecodedContractError | null {
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`;
  const entry = Object.prototype.hasOwnProperty.call(contractErrors, selector) ? contractErrors[selector] : null;
  if (!entry) return null;
  try {
    const fragment = ErrorFragment.from(`error ${entry.signature}`);
    const args = new Interface([fragment]).decodeErrorResult(fragment, data);
    return { selector, name: entry.name, signature: entry.signature, contracts: entry.contracts, args: [...args] };
  } catch {
    return null;
  }
}

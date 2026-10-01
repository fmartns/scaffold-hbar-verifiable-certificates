import { useMemo } from "react";
import { DeploymentNotFoundError, getDeployedContract } from "@sh/sdk/hedera/contracts";
import type { ContractName, DeployedContract } from "@sh/sdk/hedera/contracts";
import type { HederaNetworkName } from "@sh/sdk/hedera/networks";

export type DeployedContractState<N extends ContractName> =
  | { status: "ready"; contract: DeployedContract<N> }
  /** No deployment recorded for this network; `message` names the network, chain and the deploy command. */
  | { status: "missing"; message: string }
  | { status: "invalid"; message: string };

/**
 * Address, typed ABI and HashScan link of one of the template's contracts on `network`, from the codegen manifest
 * (`packages/sdk/generated`). `override` (e.g. an address configured on the server) takes precedence.
 */
export function useDeployedContract<N extends ContractName>(
  name: N,
  network: HederaNetworkName,
  override?: string | null,
): DeployedContractState<N> {
  return useMemo(() => {
    try {
      return { status: "ready", contract: getDeployedContract(name, network, { override }) };
    } catch (error) {
      if (error instanceof DeploymentNotFoundError) return { status: "missing", message: error.message };
      return { status: "invalid", message: error instanceof Error ? error.message : `Invalid ${name} address.` };
    }
  }, [name, network, override]);
}

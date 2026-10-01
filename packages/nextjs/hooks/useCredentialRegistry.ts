import { useCallback, useMemo, useState } from "react";
import { createCredentialStatusReader } from "@sh/sdk/hedera/audit/registry";
import type { OnChainCredentialRecord } from "@sh/sdk/hedera/audit/registry";
import { NETWORKS } from "@sh/sdk/hedera/networks";
import type { HederaNetworkName } from "@sh/sdk/hedera/networks";
import { useDeployedContract } from "./useDeployedContract";

export type CredentialStatusLookup =
  | { status: "idle" }
  | { status: "loading"; credentialId: string }
  | { status: "done"; credentialId: string; record: OnChainCredentialRecord }
  | { status: "error"; credentialId: string; message: string };

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * Domain hook over `CredentialRegistry`: the deployment (from the codegen manifest, no address or ABI in the
 * component) and verbs on it. `getCredentialStatus` reads `statusOf`, the authority on a credential's state, through the
 * PUBLIC relay of the network (never `HEDERA_RPC_URL`, which may carry a key and must not reach the browser).
 */
export function useCredentialRegistry({
  network,
  address,
}: {
  network: HederaNetworkName;
  /** Explicitly configured address; defaults to the manifest. */
  address?: string | null;
}) {
  const deployment = useDeployedContract("CredentialRegistry", network, address);
  const [lookup, setLookup] = useState<CredentialStatusLookup>({ status: "idle" });

  const reader = useMemo(
    () =>
      deployment.status === "ready"
        ? createCredentialStatusReader({ network: NETWORKS[network], registryAddress: deployment.contract.address })
        : null,
    [deployment, network],
  );

  const getCredentialStatus = useCallback(
    async (input: string) => {
      const credentialId = input.trim();
      if (!reader) return;
      if (!BYTES32.test(credentialId)) {
        setLookup({ status: "error", credentialId, message: "A credentialId is 0x followed by 64 hex characters." });
        return;
      }
      setLookup({ status: "loading", credentialId });
      try {
        setLookup({ status: "done", credentialId, record: await reader.statusOf(credentialId) });
      } catch (error) {
        setLookup({
          status: "error",
          credentialId,
          message: error instanceof Error ? error.message : "The registry could not be read.",
        });
      }
    },
    [reader],
  );

  return { deployment, lookup, getCredentialStatus };
}

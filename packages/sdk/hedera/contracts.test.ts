import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import {
  DeploymentNotFoundError,
  contractAbis,
  decodeContractError,
  describeDeployments,
  findDeployment,
  getDeployedContract,
  lookupContractId,
  missingDeploymentMessage,
} from "./contracts";
import type { GeneratedDeployments } from "./contracts";
import { NETWORKS } from "./networks";

const ADDRESS = "0x" + "a1".repeat(20);
const manifest: GeneratedDeployments = {
  testnet: {
    CredentialRegistry: {
      address: ADDRESS as `0x${string}`,
      contractId: "0.0.5005",
      deployTxHash: `0x${"cd".repeat(32)}`,
      blockNumber: 12,
      abiHash: `0x${"ef".repeat(32)}`,
    },
  },
};

describe("deployment manifest resolver", () => {
  it("resolves address, typed ABI, contract id and HashScan link from the manifest", () => {
    const c = getDeployedContract("CredentialRegistry", "testnet", { manifest });
    expect(c).toMatchObject({ address: ADDRESS, source: "manifest", contractId: "0.0.5005" });
    expect(c.abi).toBe(contractAbis.CredentialRegistry);
    expect(c.hashscanUrl).toBe("https://hashscan.io/testnet/contract/0.0.5005");
  });

  it("fails loudly with network, chain id and the deploy command when nothing is deployed", () => {
    expect(() => getDeployedContract("CredentialRegistry", "testnet", { manifest: {} })).toThrow(
      DeploymentNotFoundError,
    );
    expect(missingDeploymentMessage("CredentialRegistry", "testnet")).toBe(
      "No CredentialRegistry deployment for testnet (chain 296) in packages/sdk/generated. " +
        "Run `yarn deploy --network hederaTestnet`.",
    );
    expect(findDeployment("CredentialRegistry", "mainnet", manifest)).toBeNull();
  });

  it("lets an explicit address win over the manifest and validates it", () => {
    const other = "0x" + "b2".repeat(20);
    const c = getDeployedContract("CredentialRegistry", "testnet", {
      manifest,
      override: other.toUpperCase().replace("0X", "0x"),
    });
    expect(c).toMatchObject({ address: other, source: "override", contractId: null, deployment: null });
    expect(() => getDeployedContract("CredentialRegistry", "testnet", { override: "0x1234" })).toThrow(
      "not a valid, non-zero EVM address",
    );
    expect(() => getDeployedContract("CredentialRegistry", "testnet", { override: "0x" + "0".repeat(40) })).toThrow(
      "not a valid, non-zero EVM address",
    );
  });

  it("has no HashScan link on a network without a public explorer", () => {
    const local = { local: manifest.testnet };
    expect(getDeployedContract("CredentialRegistry", "local", { manifest: local }).hashscanUrl).toBeNull();
  });

  it("describes each contract for `yarn setup`", () => {
    expect(describeDeployments("testnet", manifest)).toEqual([
      `CredentialRegistry: ${ADDRESS} (0.0.5005) https://hashscan.io/testnet/contract/0.0.5005`,
    ]);
    expect(describeDeployments("testnet", {})).toEqual([
      `CredentialRegistry: ${missingDeploymentMessage("CredentialRegistry", "testnet")}`,
    ]);
  });
});

describe("decodeContractError", () => {
  const registry = new Interface(contractAbis.CredentialRegistry);

  it("decodes a CredentialRegistry custom error from the generated table", () => {
    const credentialId = "0x" + "11".repeat(32);
    const fragment = registry.getError("AlreadyIssued")!;
    const args = fragment.inputs.map(input => (input.type === "bytes32" ? credentialId : 5n));
    const data = registry.encodeErrorResult(fragment, args);
    expect(decodeContractError(data)).toMatchObject({
      name: "AlreadyIssued",
      signature: fragment.format("sighash"),
      contracts: ["CredentialRegistry"],
      args,
    });
  });

  it("returns null for data that is not a known custom error", () => {
    expect(decodeContractError("0x")).toBeNull();
    expect(decodeContractError(undefined)).toBeNull();
    expect(decodeContractError("0xdeadbeef")).toBeNull();
    // Error(string): a require message, not a custom error.
    expect(decodeContractError(new Interface(["error Error(string)"]).encodeErrorResult("Error", ["no"]))).toBeNull();
  });
});

describe("lookupContractId", () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

  it("returns the Mirror Node contract id", async () => {
    let url = "";
    const fetchImpl = (async (input: string | URL | Request) => {
      url = String(input);
      return new Response(JSON.stringify({ contract_id: "0.0.77" }));
    }) as typeof fetch;
    expect(await lookupContractId(NETWORKS.testnet, ADDRESS, { fetch: fetchImpl })).toBe("0.0.77");
    expect(url).toBe(`https://testnet.mirrornode.hedera.com/api/v1/contracts/${ADDRESS}`);
  });

  it("returns null when not indexed yet, malformed or unreachable", async () => {
    expect(await lookupContractId(NETWORKS.testnet, ADDRESS, { fetch: respond(404, {}) })).toBeNull();
    expect(await lookupContractId(NETWORKS.testnet, ADDRESS, { fetch: respond(200, { contract_id: "x" }) })).toBeNull();
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await lookupContractId(NETWORKS.testnet, ADDRESS, { fetch: down })).toBeNull();
  });
});

/**
 * The accreditation authority's registry on the Hedera Smart Contract Service (packages/hardhat): which credential
 * definitions are recognized for which course, and since/until when.
 *
 * Platform B reads it at decision time instead of trusting a credential definition hard-coded in its code: the
 * authority can recognize a new issuer or withdraw one, publicly and with history, without touching any verifier. It is
 * not a second source of certificate status — revocation stays in AnonCreds on HCS.
 *
 * Reads go through the Mirror Node (`POST /api/v1/contracts/call`, free, no JSON-RPC relay). Writes use the Hedera SDK
 * (`ContractCreateTransaction` with inline initcode, `ContractExecuteTransaction`), so they work with an ED25519 or an ECDSA operator key.
 */
import {
  ContractCreateTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
} from "@hashgraph/sdk";
import type { Client } from "@hashgraph/sdk";
import { Interface } from "ethers";
import { ACCREDITATION_REGISTRY_ABI, ACCREDITATION_REGISTRY_BYTECODE } from "../generated/AccreditationRegistry";
import { CertificateError } from "./errors";

/** What a relying party needs to know about accreditation. */
export interface AccreditationReader {
  /** Every credential definition ever accredited for `course` (withdrawn ones included). */
  credentialDefinitions(course: string): Promise<string[]>;
  /** Whether `credentialDefinitionId` was accredited for `course` at Unix time `at` (seconds). */
  isAccredited(course: string, credentialDefinitionId: string, at: number): Promise<boolean>;
}

const abi = new Interface(ACCREDITATION_REGISTRY_ABI);
const MIRROR_TIMEOUT_MS = 10_000;
/**
 * Gas limits: measured on Testnet (deploy 571,034; accredit with a full credential definition id 185,047) plus about
 * 20%. Hedera charges at least 80% of the limit, so a generous limit is paid for.
 */
const GAS = { deploy: 700_000, write: 250_000 } as const;

export class MirrorAccreditationReader implements AccreditationReader {
  constructor(
    private readonly mirrorNodeUrl: string,
    /** EVM address of the deployed registry (`0x…`). */
    private readonly contractAddress: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(contractAddress))
      throw new CertificateError("INVALID_INPUT", "Invalid contract address.");
  }

  private async call(method: "credentialDefinitions" | "isAccredited", args: unknown[]) {
    const url = `${this.mirrorNodeUrl.replace(/\/+$/, "")}/api/v1/contracts/call`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ to: this.contractAddress, data: abi.encodeFunctionData(method, args), block: "latest" }),
        signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
      });
    } catch {
      throw new CertificateError(
        "LEDGER_READ_FAILED",
        "Mirror Node unreachable while reading the accreditation registry.",
      );
    }
    if (!response.ok) {
      throw new CertificateError("LEDGER_READ_FAILED", `Accreditation registry read failed (HTTP ${response.status}).`);
    }
    const { result } = (await response.json()) as { result?: string };
    try {
      return abi.decodeFunctionResult(method, result ?? "0x");
    } catch {
      throw new CertificateError("LEDGER_READ_FAILED", "The accreditation registry returned an unexpected result.");
    }
  }

  async credentialDefinitions(course: string): Promise<string[]> {
    const [definitions] = await this.call("credentialDefinitions", [course]);
    return [...(definitions as string[])];
  }

  async isAccredited(course: string, credentialDefinitionId: string, at: number): Promise<boolean> {
    const [accredited] = await this.call("isAccredited", [course, credentialDefinitionId, at]);
    return accredited as boolean;
  }
}

export interface DeployedRegistry {
  contractId: string;
  evmAddress: string;
}

const wrapWrite = async <T>(what: string, action: () => Promise<T>): Promise<T> => {
  try {
    return await action();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CertificateError("LEDGER_WRITE_FAILED", `Could not ${what}: ${reason}`);
  }
};

/** Deploys the registry; the operator account becomes its accreditation authority. */
export function deployAccreditationRegistry(client: Client): Promise<DeployedRegistry> {
  return wrapWrite("deploy the accreditation registry", async () => {
    // The initcode (about 2.5 KB) fits in the transaction, so no File Service upload is needed.
    const response = await new ContractCreateTransaction()
      .setBytecode(Buffer.from(ACCREDITATION_REGISTRY_BYTECODE.slice(2), "hex"))
      .setGas(GAS.deploy)
      .execute(client);
    const contractId = (await response.getReceipt(client)).contractId!;
    return { contractId: contractId.toString(), evmAddress: `0x${contractId.toEvmAddress()}` };
  });
}

/** Accredits (`accredit`) or withdraws (`withdraw`) a credential definition for a course. Returns the transaction id. */
export function changeAccreditation(
  client: Client,
  contractId: string,
  action: "accredit" | "withdraw",
  course: string,
  credentialDefinitionId: string,
): Promise<string> {
  return wrapWrite(`${action} the credential definition`, async () => {
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(contractId))
      .setGas(GAS.write)
      .setFunction(action, new ContractFunctionParameters().addString(course).addString(credentialDefinitionId))
      .execute(client);
    await response.getReceipt(client);
    return response.transactionId.toString();
  });
}

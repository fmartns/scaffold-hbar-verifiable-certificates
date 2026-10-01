/**
 * Write side of `CredentialRegistry` (#9) for the issuer: calldata of `issue`/`revoke`, the `issuerOf` view, and the
 * decoding of its custom errors. Browser-safe (ethers only). The read side used by the audit lives in
 * `../audit/registry`. The ABI is the one generated from the compiled contract (#24).
 */
import { Interface } from "ethers";
import { CredentialRegistryAbi } from "../../generated";
import type { CredentialEvent } from "../hcs/credential-envelope";
import type { Hex } from "../hcs/envelope";

/** The registry ABI generated from the compiled contract (#24); never a hand-written fragment. */
export const CREDENTIAL_REGISTRY_ISSUER_ABI = CredentialRegistryAbi;

const REGISTRY = new Interface(CREDENTIAL_REGISTRY_ISSUER_ABI);

/** The custom errors `issue`/`revoke` can raise; the console explains each one. */
export const REGISTRY_ERROR_NAMES = [
  "Paused",
  "UnsupportedVersion",
  "InvalidField",
  "SubmitterMismatch",
  "UnknownIssuer",
  "InactiveIssuer",
  "InvalidSignature",
  "UnauthorizedSigner",
  "AlreadyIssued",
  "ConflictingCredential",
  "Expired",
  "SignedInFuture",
  "ValidityWindowTooLong",
  "UnknownCredential",
  "AlreadyRevoked",
  "UnauthorizedRevoker",
] as const;
export type RegistryErrorName = (typeof REGISTRY_ERROR_NAMES)[number];

const isRegistryErrorName = (name: string): name is RegistryErrorName =>
  (REGISTRY_ERROR_NAMES as readonly string[]).includes(name);

export interface DecodedRegistryError {
  /** A registry custom error, or `Error` for a `revert("…")` string. */
  name: RegistryErrorName | "Error";
  /** Arguments as strings (addresses and bytes32 lowercase hex, integers decimal). */
  args: Record<string, string>;
}

export interface HcsRefInput {
  sequence: string | bigint;
  consensusTimestampNs: string | bigint;
}

/**
 * Placeholder `HcsRef` for a dry-run (`eth_call`) of `issue` BEFORE publishing: the contract only checks
 * `sequence != 0`, so the simulation catches every other revert (unknown issuer, duplicate, expiry…) without paying
 * for an HCS message. Never send a transaction with it.
 */
export const SIMULATION_HCS_REF: HcsRefInput = { sequence: 1n, consensusTimestampNs: 0n };

export function encodeIssueCall(event: CredentialEvent, signature: string, hcs: HcsRefInput): Hex {
  return REGISTRY.encodeFunctionData("issue", [
    [
      event.version,
      event.issuer,
      event.externalCredentialId,
      event.credentialHash,
      event.subjectCommitment,
      event.schemaId,
      event.signedAt,
      event.validUntil,
      event.submitter,
    ],
    signature,
    [BigInt(hcs.sequence), BigInt(hcs.consensusTimestampNs)],
  ]) as Hex;
}

export function encodeRevokeCall(credentialId: string): Hex {
  return REGISTRY.encodeFunctionData("revoke", [credentialId]) as Hex;
}

export interface IssuerConfigView {
  signer: Hex;
  active: boolean;
  maxValidity: bigint;
  /** `signer == address(0)`: the namespace was never registered. */
  registered: boolean;
}

export function encodeIssuerOfCall(issuer: string): Hex {
  return REGISTRY.encodeFunctionData("issuerOf", [issuer]) as Hex;
}

/** Throws when `result` is not an `issuerOf` answer. */
export function decodeIssuerOfResult(result: string): IssuerConfigView {
  const [cfg] = REGISTRY.decodeFunctionResult("issuerOf", result);
  const signer = String(cfg.signer).toLowerCase() as Hex;
  return {
    signer,
    active: Boolean(cfg.active),
    maxValidity: BigInt(cfg.maxValidity),
    registered: !/^0x0{40}$/.test(signer),
  };
}

const ERROR_STRING_SELECTOR = "0x08c379a0";

/** Decodes revert data of a registry call. `null` when it is not a registry error or a revert string. */
export function decodeRegistryError(data: string): DecodedRegistryError | null {
  if (!/^0x[0-9a-fA-F]{8}/.test(data)) return null;
  if (data.slice(0, 10).toLowerCase() === ERROR_STRING_SELECTOR) {
    try {
      const [reason] = REGISTRY.getAbiCoder().decode(["string"], `0x${data.slice(10)}`);
      return { name: "Error", args: { reason: String(reason) } };
    } catch {
      return null;
    }
  }
  try {
    const parsed = REGISTRY.parseError(data);
    if (!parsed || !isRegistryErrorName(parsed.name)) return null;
    const args: Record<string, string> = {};
    parsed.fragment.inputs.forEach((input, i) => {
      const value = parsed.args[i];
      args[input.name] = typeof value === "string" ? value.toLowerCase() : String(value);
    });
    return { name: parsed.name, args };
  } catch {
    return null;
  }
}

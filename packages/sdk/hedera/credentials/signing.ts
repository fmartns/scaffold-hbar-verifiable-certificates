/**
 * EIP-712 payloads for a browser wallet (`eth_signTypedData_v4`). The types and domain are those of the credential
 * envelope, so what the wallet signs is exactly what `CredentialRegistry` and the audit verify. uint64 values are sent
 * as decimal strings: JSON has no bigint and a JS number would lose precision.
 */
import {
  CREDENTIAL_EIP712_NAME,
  CREDENTIAL_EIP712_VERSION,
  CREDENTIAL_EVENT_TYPES,
  CREDENTIAL_REVOCATION_TYPES,
} from "../hcs/credential-envelope";
import type { CredentialEvent, CredentialRevocation } from "../hcs/credential-envelope";
import type { SigningDomain } from "../hcs/envelope";

const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export interface Eip712Payload {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  message: Record<string, string | number>;
}

function walletDomain(domain: SigningDomain) {
  return {
    name: CREDENTIAL_EIP712_NAME,
    version: CREDENTIAL_EIP712_VERSION,
    chainId: Number(domain.chainId),
    verifyingContract: domain.verifyingContract.toLowerCase(),
  };
}

export function credentialEventTypedData(event: CredentialEvent, domain: SigningDomain): Eip712Payload {
  return {
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...CREDENTIAL_EVENT_TYPES },
    primaryType: "CredentialEvent",
    domain: walletDomain(domain),
    message: {
      version: event.version,
      issuer: event.issuer,
      externalCredentialId: event.externalCredentialId,
      credentialHash: event.credentialHash,
      subjectCommitment: event.subjectCommitment,
      schemaId: event.schemaId,
      signedAt: event.signedAt.toString(),
      validUntil: event.validUntil.toString(),
      submitter: event.submitter,
    },
  };
}

export function credentialRevocationTypedData(revocation: CredentialRevocation, domain: SigningDomain): Eip712Payload {
  return {
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...CREDENTIAL_REVOCATION_TYPES },
    primaryType: "CredentialRevocation",
    domain: walletDomain(domain),
    message: {
      version: revocation.version,
      credentialId: revocation.credentialId,
      issuer: revocation.issuer,
      reasonCode: revocation.reasonCode,
      signedAt: revocation.signedAt.toString(),
    },
  };
}

/** JSON-safe copy of an event (uint64 as decimal strings), for an HTTP body. `validateCredentialEvent` accepts it. */
export function serializeCredentialEvent(event: CredentialEvent): Record<string, string | number> {
  return { ...event, signedAt: event.signedAt.toString(), validUntil: event.validUntil.toString() };
}

export function serializeCredentialRevocation(revocation: CredentialRevocation): Record<string, string | number> {
  return { ...revocation, signedAt: revocation.signedAt.toString() };
}

/**
 * Typed failures of the certificate flow. `code` is stable and machine-readable; `message` never contains a private key,
 * a link secret or a holder attribute value.
 */
export type CertificateErrorCode =
  /** The issuer has not published its DID, schema, credential definition and revocation registry yet. */
  | "ISSUER_NOT_INITIALIZED"
  /** No certificate (or holder wallet) with that identifier. */
  | "NOT_FOUND"
  /** Input rejected before anything was sent to Hedera. */
  | "INVALID_INPUT"
  /** A Hedera write (topic, message, AnonCreds object) failed or was not confirmed. */
  | "LEDGER_WRITE_FAILED"
  /** A Hedera read through the Mirror Node failed or returned data that is not what it claims to be. */
  | "LEDGER_READ_FAILED"
  /** The HCS-1 file is incomplete, malformed or does not match the hash in its topic memo. */
  | "DOCUMENT_INVALID"
  /** The revocation registry has no free index left. */
  | "REGISTRY_FULL"
  /** The holder could not build the requested proof: no matching credential, predicate not met, or revoked. */
  | "PROOF_UNAVAILABLE";

export class CertificateError extends Error {
  constructor(
    readonly code: CertificateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CertificateError";
  }
}

/**
 * Platform B, the relying party. It never calls the issuer: it asks the holder for a proof and decides from what the
 * proof and Hedera say.
 *
 * - Enrollment: "Advanced Solidity" requires a non-revoked "Solidity Basics" certificate from a trusted issuer with a
 *   grade of at least 70. Platform B learns the course and that the grade is high enough, never the grade itself, the
 *   holder's name or student id.
 * - Document check: is this PDF exactly the picture of a certificate the holder controls, and is it still valid?
 *   The holder reveals `document_sha256`; Platform B hashes the file it was given and compares.
 */
import type { AnonCredsProof, AnonCredsProofRequest } from "@credo-ts/anoncreds";
import type { Agent } from "@credo-ts/core";
import { CertificateError } from "./errors";
import { sha256Hex } from "./hcs1";
import { anoncredsNonce, buildProofRequest, createPresentation, verifyPresentation } from "./presentation";
import type { Verification } from "./presentation";

export const ENROLLMENT_POLICY = {
  offering: "Advanced Solidity",
  prerequisite: "Solidity Basics",
  minimumGrade: 70,
} as const;

export function enrollmentRequest(credentialDefinitionId: string, asOf: number): AnonCredsProofRequest {
  return buildProofRequest({
    name: `Enrollment in ${ENROLLMENT_POLICY.offering}`,
    credentialDefinitionId,
    reveal: [{ name: "course" }],
    predicates: [{ name: "grade", minimum: ENROLLMENT_POLICY.minimumGrade }],
    asOf,
    nonce: anoncredsNonce(),
  });
}

export function documentRequest(credentialDefinitionId: string, asOf: number): AnonCredsProofRequest {
  return buildProofRequest({
    name: "Certificate document check",
    credentialDefinitionId,
    reveal: [{ name: "course" }, { name: "certificate_id" }, { name: "document_sha256" }],
    asOf,
    nonce: anoncredsNonce(),
  });
}

export interface Decision {
  approved: boolean;
  reasons: string[];
  request: AnonCredsProofRequest;
  /** Absent when the holder could not even build a proof. */
  verification?: Verification;
}

/** Runs one request/present/verify round between a holder and Platform B. A holder failure is a denial, not an error. */
async function round(
  holder: Agent,
  credentialId: string | undefined,
  verifier: Agent,
  request: AnonCredsProofRequest,
): Promise<{ proof?: AnonCredsProof; verification?: Verification; failure?: string }> {
  if (!credentialId) return { failure: "The holder has no certificate to present." };
  let proof: AnonCredsProof;
  try {
    proof = await createPresentation(holder, credentialId, request);
  } catch (error) {
    if (error instanceof CertificateError && error.code === "PROOF_UNAVAILABLE") return { failure: error.message };
    throw error;
  }
  return { proof, verification: await verifyPresentation(verifier, request, proof) };
}

export async function decideEnrollment(
  context: { holder: Agent; credentialId?: string; verifier: Agent; trustedCredentialDefinitionId: string },
  asOf: number,
): Promise<Decision> {
  const request = enrollmentRequest(context.trustedCredentialDefinitionId, asOf);
  const { verification, failure } = await round(context.holder, context.credentialId, context.verifier, request);
  if (!verification) return { approved: false, reasons: [failure!], request };

  const reasons: string[] = [];
  if (!verification.verified) reasons.push(verification.reason ?? "The proof does not verify.");
  if (verification.revealed.course !== ENROLLMENT_POLICY.prerequisite) {
    reasons.push(`The certificate is for "${verification.revealed.course}", not "${ENROLLMENT_POLICY.prerequisite}".`);
  }
  return { approved: reasons.length === 0, reasons, request, verification };
}

export interface DocumentCheck extends Decision {
  /** SHA-256 of the file Platform B was given. */
  fileSha256: string;
  /** Whether the file is exactly the document the credential commits to. */
  documentMatches: boolean;
}

/** `verifyDownloadedCertificate`: is `file` the document of a credential the holder proves, valid at `asOf`? */
export async function verifyDownloadedCertificate(
  context: { holder: Agent; credentialId?: string; verifier: Agent; trustedCredentialDefinitionId: string },
  file: Uint8Array,
  asOf: number,
): Promise<DocumentCheck> {
  const fileSha256 = sha256Hex(file);
  const request = documentRequest(context.trustedCredentialDefinitionId, asOf);
  const { verification, failure } = await round(context.holder, context.credentialId, context.verifier, request);
  if (!verification) return { approved: false, reasons: [failure!], request, fileSha256, documentMatches: false };

  const documentMatches = verification.revealed.document_sha256 === fileSha256;
  const reasons: string[] = [];
  if (!documentMatches) reasons.push("The file is not the document this credential commits to (SHA-256 mismatch).");
  if (!verification.verified) reasons.push(verification.reason ?? "The proof does not verify.");
  return { approved: reasons.length === 0, reasons, request, verification, fileSha256, documentMatches };
}

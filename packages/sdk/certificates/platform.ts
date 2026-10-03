/**
 * Platform B, the relying party. It never calls the issuer: it asks the accreditation registry which issuers to trust,
 * asks the holder for a proof, and decides from what the proof and Hedera say.
 *
 * - Enrollment: "Advanced Solidity" requires a non-revoked "Solidity Basics" certificate whose credential definition was
 *   accredited for that course at the time asked, with a grade of at least 70. Platform B learns the course and that
 *   the grade is high enough, never the grade itself, the holder's name or student id.
 * - Document check: is this PDF exactly the picture of a certificate the holder controls, and is it still valid?
 *   The holder reveals `document_sha256`; Platform B hashes the file it was given and compares.
 */
import type { AnonCredsProof, AnonCredsProofRequest } from "@credo-ts/anoncreds";
import type { Agent } from "@credo-ts/core";
import type { AccreditationReader } from "./accreditation";
import { CertificateError } from "./errors";
import { sha256Hex } from "./hcs1";
import { anoncredsNonce, buildProofRequest, createPresentation, verifyPresentation } from "./presentation";
import type { RequestedAttribute, RequestedPredicate, Verification } from "./presentation";

export const ENROLLMENT_POLICY = {
  offering: "Advanced Solidity",
  prerequisite: "Solidity Basics",
  minimumGrade: 70,
} as const;

export interface PlatformContext {
  holder: Agent;
  /** The credential the holder presents; absent when the holder has none (e.g. only a copy of someone's PDF). */
  credentialId?: string;
  verifier: Agent;
  accreditation: AccreditationReader;
}

export interface Decision {
  approved: boolean;
  reasons: string[];
  /** The proof request Platform B sent; absent when no issuer was accredited, so nothing could be asked. */
  request?: AnonCredsProofRequest;
  /** Absent when the holder could not build a proof. */
  verification?: Verification;
  /** Whether the credential definition the proof used was accredited for the course at the time asked. */
  accreditation?: { credentialDefinitionId: string; accredited: boolean };
}

const utc = (seconds: number) => new Date(seconds * 1000).toISOString();

/** Request → presentation → verification → accreditation, for proofs about `ENROLLMENT_POLICY.prerequisite`. */
async function decide(
  context: PlatformContext,
  asOf: number,
  ask: { name: string; reveal: RequestedAttribute[]; predicates?: RequestedPredicate[] },
): Promise<Decision> {
  const course = ENROLLMENT_POLICY.prerequisite;
  const trusted = await context.accreditation.credentialDefinitions(course);
  if (trusted.length === 0)
    return { approved: false, reasons: [`No issuer has ever been accredited for "${course}".`] };

  const request = buildProofRequest({ ...ask, credentialDefinitionIds: trusted, asOf, nonce: anoncredsNonce() });
  if (!context.credentialId)
    return { approved: false, reasons: ["The holder has no certificate to present."], request };

  let proof: AnonCredsProof;
  try {
    proof = await createPresentation(context.holder, context.credentialId, request);
  } catch (error) {
    if (error instanceof CertificateError && error.code === "PROOF_UNAVAILABLE") {
      return { approved: false, reasons: [error.message], request };
    }
    throw error;
  }
  const verification = await verifyPresentation(context.verifier, request, proof);

  const reasons: string[] = [];
  if (!verification.verified) reasons.push(verification.reason ?? "The proof does not verify.");
  const credentialDefinitionId = verification.resolved[0]?.credentialDefinitionId ?? "";
  const accredited = await context.accreditation.isAccredited(course, credentialDefinitionId, asOf);
  if (!accredited) reasons.push(`The certificate's issuer was not accredited for "${course}" at ${utc(asOf)}.`);
  return {
    approved: reasons.length === 0,
    reasons,
    request,
    verification,
    accreditation: { credentialDefinitionId, accredited },
  };
}

/** Platform B decides on enrollment in Advanced Solidity, as of `asOf` (Unix seconds). */
export async function decideEnrollment(context: PlatformContext, asOf: number): Promise<Decision> {
  const decision = await decide(context, asOf, {
    name: `Enrollment in ${ENROLLMENT_POLICY.offering}`,
    reveal: [{ name: "course" }],
    predicates: [{ name: "grade", minimum: ENROLLMENT_POLICY.minimumGrade }],
  });
  const course = decision.verification?.revealed.course;
  if (decision.verification && course !== ENROLLMENT_POLICY.prerequisite) {
    return {
      ...decision,
      approved: false,
      reasons: [...decision.reasons, `The certificate is for "${course}", not "${ENROLLMENT_POLICY.prerequisite}".`],
    };
  }
  return decision;
}

export interface DocumentCheck extends Decision {
  /** SHA-256 of the file Platform B was given. */
  fileSha256: string;
  /** Whether the file is exactly the document the credential commits to. */
  documentMatches: boolean;
}

/** `verifyDownloadedCertificate`: is `file` the document of a credential the holder proves, valid at `asOf`? */
export async function verifyDownloadedCertificate(
  context: PlatformContext,
  file: Uint8Array,
  asOf: number,
): Promise<DocumentCheck> {
  const fileSha256 = sha256Hex(file);
  const decision = await decide(context, asOf, {
    name: "Certificate document check",
    reveal: [{ name: "course" }, { name: "certificate_id" }, { name: "document_sha256" }],
  });
  const documentMatches = decision.verification?.revealed.document_sha256 === fileSha256;
  const reasons = [...decision.reasons];
  if (decision.verification && !documentMatches) {
    reasons.unshift("The file is not the document this credential commits to (SHA-256 mismatch).");
  }
  return { ...decision, approved: decision.approved && documentMatches, reasons, fileSha256, documentMatches };
}

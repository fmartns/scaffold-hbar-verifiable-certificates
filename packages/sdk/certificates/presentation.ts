/**
 * Proof requests, presentations and verification.
 *
 * The holder proves only what a request asks for: revealed attributes, predicates over hidden ones (`grade >= 70`
 * without the grade) and non-revocation at a point in time. The verifier checks the proof against objects it resolves
 * itself from Hedera: schema and credential definition (HCS-1 files) and the revocation state at the proof's timestamp,
 * which the Hedera AnonCreds registry rebuilds by replaying the issuer's revocation entries topic up to that consensus
 * time. Nothing in the verification comes from the issuer's server.
 */
import { AnonCredsHolderServiceSymbol, AnonCredsVerifierServiceSymbol } from "@credo-ts/anoncreds";
import type {
  AnonCredsHolderService,
  AnonCredsProof,
  AnonCredsProofRequest,
  AnonCredsVerifierService,
  VerifyProofOptions,
} from "@credo-ts/anoncreds";
import { randomBytes } from "node:crypto";
import type { Agent } from "@credo-ts/core";
import { CertificateError } from "./errors";

/** AnonCreds nonce: a fresh 80-bit random integer in decimal, so a presentation cannot be replayed. */
export const anoncredsNonce = (): string => BigInt(`0x${randomBytes(10).toString("hex")}`).toString();

export interface RequestedAttribute {
  name: string;
}

export interface RequestedPredicate {
  name: string;
  minimum: number;
}

/**
 * A proof request restricted to one credential definition, asking for non-revocation exactly at `asOf` (Unix seconds).
 * `from = to = asOf` matters: an open interval would let a revoked holder prove with an older revocation state.
 */
export function buildProofRequest(options: {
  name: string;
  credentialDefinitionId: string;
  reveal: RequestedAttribute[];
  predicates?: RequestedPredicate[];
  asOf: number;
  nonce: string;
}): AnonCredsProofRequest {
  const restrictions = [{ cred_def_id: options.credentialDefinitionId }];
  return {
    name: options.name,
    version: "1.0",
    nonce: options.nonce,
    requested_attributes: Object.fromEntries(options.reveal.map(({ name }) => [name, { name, restrictions }])),
    requested_predicates: Object.fromEntries(
      (options.predicates ?? []).map(({ name, minimum }) => [
        name,
        { name, p_type: ">=" as const, p_value: minimum, restrictions },
      ]),
    ),
    non_revoked: { from: options.asOf, to: options.asOf },
  };
}

/** Builds a presentation for `request` from one credential of the holder's wallet. */
export async function createPresentation(
  holder: Agent,
  credentialId: string,
  request: AnonCredsProofRequest,
): Promise<AnonCredsProof> {
  const holderService = holder.dependencyManager.resolve<AnonCredsHolderService>(AnonCredsHolderServiceSymbol);
  const asOf = request.non_revoked?.to;
  if (asOf === undefined) throw new CertificateError("INVALID_INPUT", "The proof request must set non_revoked.");

  try {
    const credentialInfo = await holderService.getCredential(holder.context, { id: credentialId });
    const { schemaId, credentialDefinitionId, revocationRegistryId } = credentialInfo;
    if (!revocationRegistryId) throw new CertificateError("PROOF_UNAVAILABLE", "The credential is not revocable.");

    const anoncreds = holder.modules.anoncreds;
    const [{ schema }, { credentialDefinition }, { revocationRegistryDefinition }, { revocationStatusList }] =
      await Promise.all([
        anoncreds.getSchema(schemaId),
        anoncreds.getCredentialDefinition(credentialDefinitionId),
        anoncreds.getRevocationRegistryDefinition(revocationRegistryId),
        anoncreds.getRevocationStatusList(revocationRegistryId, asOf),
      ]);
    if (!schema || !credentialDefinition || !revocationRegistryDefinition || !revocationStatusList) {
      throw new CertificateError("LEDGER_READ_FAILED", "Could not resolve the credential's objects from Hedera.");
    }
    const { tailsFilePath } = await anoncreds.config.tailsFileService.getTailsFile(holder.context, {
      revocationRegistryDefinition,
    });

    const match = { credentialId, credentialInfo, timestamp: revocationStatusList.timestamp };
    return await holderService.createProof(holder.context, {
      proofRequest: request,
      selectedCredentials: {
        attributes: Object.fromEntries(
          Object.keys(request.requested_attributes).map(r => [r, { ...match, revealed: true }]),
        ),
        predicates: Object.fromEntries(Object.keys(request.requested_predicates).map(r => [r, match])),
        selfAttestedAttributes: {},
      },
      schemas: { [schemaId]: schema },
      credentialDefinitions: { [credentialDefinitionId]: credentialDefinition },
      revocationRegistries: {
        [revocationRegistryId]: {
          definition: revocationRegistryDefinition,
          tailsFilePath,
          revocationStatusLists: { [revocationStatusList.timestamp]: revocationStatusList },
        },
      },
    });
  } catch (error) {
    if (error instanceof CertificateError) throw error;
    throw new CertificateError(
      "PROOF_UNAVAILABLE",
      `The holder could not build this proof: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface Verification {
  verified: boolean;
  /** Why `verified` is false, in plain words. */
  reason?: string;
  /** Raw values of the revealed attributes: everything the verifier learns besides the predicates. */
  revealed: Record<string, string>;
  /** Predicates proven, e.g. `grade >= 70`. */
  predicates: string[];
  /** Revocation state timestamp the proof was checked against (Unix seconds). */
  revocationTimestamp?: number;
  /** Hedera objects the verifier resolved. */
  resolved: { schemaId: string; credentialDefinitionId: string; revocationRegistryId?: string }[];
}

/** Verifies `proof` against `request` using only objects resolved from Hedera by the verifier's own agent. */
export async function verifyPresentation(
  verifier: Agent,
  request: AnonCredsProofRequest,
  proof: AnonCredsProof,
): Promise<Verification> {
  const revealed = Object.fromEntries(
    Object.entries(proof.requested_proof.revealed_attrs ?? {}).map(([referent, value]) => [referent, value.raw]),
  );
  const predicates = Object.values(request.requested_predicates).map(p => `${p.name} ${p.p_type} ${p.p_value}`);
  const resolved = proof.identifiers.map(id => ({
    schemaId: id.schema_id,
    credentialDefinitionId: id.cred_def_id,
    revocationRegistryId: id.rev_reg_id ?? undefined,
  }));
  const base = { revealed, predicates, resolved };

  const interval = request.non_revoked;
  for (const id of proof.identifiers) {
    if (!id.rev_reg_id || !id.timestamp)
      return { ...base, verified: false, reason: "The proof has no non-revocation part." };
    if (interval && (id.timestamp < (interval.from ?? 0) || id.timestamp > (interval.to ?? Infinity))) {
      return {
        ...base,
        verified: false,
        reason: "The proof uses a revocation state from another time than requested.",
      };
    }
  }

  const anoncreds = verifier.modules.anoncreds;
  const schemas: VerifyProofOptions["schemas"] = {};
  const credentialDefinitions: VerifyProofOptions["credentialDefinitions"] = {};
  const revocationRegistries: VerifyProofOptions["revocationRegistries"] = {};
  for (const id of proof.identifiers) {
    const [{ schema }, { credentialDefinition }, { revocationRegistryDefinition }, { revocationStatusList }] =
      await Promise.all([
        anoncreds.getSchema(id.schema_id),
        anoncreds.getCredentialDefinition(id.cred_def_id),
        anoncreds.getRevocationRegistryDefinition(id.rev_reg_id!),
        anoncreds.getRevocationStatusList(id.rev_reg_id!, id.timestamp!),
      ]);
    if (!schema || !credentialDefinition || !revocationRegistryDefinition || !revocationStatusList) {
      throw new CertificateError("LEDGER_READ_FAILED", "Could not resolve the proof's objects from Hedera.");
    }
    schemas[id.schema_id] = schema;
    credentialDefinitions[id.cred_def_id] = credentialDefinition;
    revocationRegistries[id.rev_reg_id!] = {
      definition: revocationRegistryDefinition,
      revocationStatusLists: { [id.timestamp!]: revocationStatusList },
    };
  }

  const verifierService = verifier.dependencyManager.resolve<AnonCredsVerifierService>(AnonCredsVerifierServiceSymbol);
  let verified: boolean;
  try {
    verified = await verifierService.verifyProof(verifier.context, {
      proofRequest: request,
      proof,
      schemas,
      credentialDefinitions,
      revocationRegistries,
    });
  } catch {
    verified = false;
  }
  return {
    ...base,
    verified,
    revocationTimestamp: proof.identifiers[0]?.timestamp ?? undefined,
    ...(!verified && { reason: "The proof does not verify: the credential is revoked or the proof is invalid." }),
  };
}

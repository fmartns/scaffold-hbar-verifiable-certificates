/**
 * Reference `Attestor` (ADR §6.9): signs a draft with the exact EIP-712 types and domain the router (#9) and the shared
 * envelope code (`../hcs/envelope`, #6) use, so there is exactly one signing contract in the project. Generic over the
 * signer: the mock uses a fixed test wallet, a real deployment supplies its own key (env, KMS, HSM — anything satisfying
 * `TypedDataSigner`, which an `ethers` `Wallet` already does).
 */
import { SETTLEMENT_EVENT_TYPES, eip712Domain, validateSettlementEvent } from "../hcs/envelope";
import { OracleError } from "./errors";
import type { Attestation, AttestationDomain, Attestor, SettlementEventDraft, TypedDataSigner } from "./types";

export function createSigningAttestor(signer: TypedDataSigner): Attestor {
  return {
    async attest(draft: SettlementEventDraft, domain: AttestationDomain): Promise<Attestation> {
      // Defense in depth: attest() never signs a draft the shared schema would reject, even if a caller skipped
      // validation upstream.
      const validated = validateSettlementEvent(draft);
      if (!validated.ok) {
        throw new OracleError({
          code: "INVALID_EVENT",
          message: `Refusing to sign an invalid draft: ${validated.issues.map(i => `${i.field}: ${i.message}`).join(" ")}`,
          remediation: "Fix the draft before attesting. Nothing was signed.",
          retryable: false,
          issues: validated.issues,
        });
      }
      let signature: string;
      try {
        signature = await signer.signTypedData(
          eip712Domain(domain),
          SETTLEMENT_EVENT_TYPES,
          validated.value as unknown as Record<string, unknown>,
        );
      } catch {
        throw new OracleError({
          code: "ATTESTATION_FAILED",
          message: "Signing the attestation failed.",
          remediation: "Check the signer configuration (key, KMS/HSM access) and retry.",
          retryable: true,
        });
      }
      return { event: validated.value, signature: signature as Attestation["signature"] };
    },
  };
}

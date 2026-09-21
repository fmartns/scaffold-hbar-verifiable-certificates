import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { eip712Domain } from "../hcs/envelope";
import { createSigningAttestor } from "./attest";
import { OracleError } from "./errors";
import { normalizeObservation } from "./normalize";
import { baseContext, DOMAIN } from "./test-fixtures";

const SIGNER_KEY = `0x${"03".repeat(32)}`;
const draft = () => {
  const result = normalizeObservation(
    { providerRef: "order-42", observedAt: 1_767_225_000, data: 100n },
    baseContext(),
  );
  if (!result.ok) throw new Error("fixture invalid");
  return result.value;
};

describe("createSigningAttestor", () => {
  it("signs the draft with the exact domain and types the router expects, and recovers to the signer", async () => {
    const signer = new Wallet(SIGNER_KEY);
    const { event, signature } = await createSigningAttestor(signer).attest(draft(), DOMAIN);
    expect(event).toEqual(draft());
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    const { recoverAddress } = await import("ethers");
    const { computeAttestationDigest } = await import("../hcs/envelope");
    const digest = computeAttestationDigest(event, { ...DOMAIN, chainId: BigInt(DOMAIN.chainId) });
    expect(recoverAddress(digest, signature).toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("is deterministic: signing the same draft twice gives the same signature (ECDSA is deterministic, RFC 6979)", async () => {
    const signer = new Wallet(SIGNER_KEY);
    const attestor = createSigningAttestor(signer);
    const first = await attestor.attest(draft(), DOMAIN);
    const second = await attestor.attest(draft(), DOMAIN);
    expect(second.signature).toBe(first.signature);
  });

  it("binds the signature to the domain: another router or chain recovers a different signer relationship", async () => {
    const signer = new Wallet(SIGNER_KEY);
    const attestor = createSigningAttestor(signer);
    const here = await attestor.attest(draft(), DOMAIN);
    const elsewhere = await attestor.attest(draft(), { ...DOMAIN, chainId: 295 });
    expect(elsewhere.signature).not.toBe(here.signature);
  });

  it("refuses to sign an invalid draft, and never calls the signer", async () => {
    let called = false;
    const signer = { address: new Wallet(SIGNER_KEY).address, signTypedData: async () => ((called = true), "0x") };
    const bad = { ...draft(), policyId: `0x${"00".repeat(32)}` } as never;
    const error = await createSigningAttestor(signer)
      .attest(bad, DOMAIN)
      .then(
        () => null,
        e => e as OracleError,
      );
    expect(error).toBeInstanceOf(OracleError);
    expect(error?.code).toBe("INVALID_EVENT");
    expect(called).toBe(false);
  });

  it("normalizes a signer failure without leaking its message", async () => {
    const signer = {
      address: "0x0",
      signTypedData: async () => {
        throw new Error("KMS credentials secret-abc123 rejected");
      },
    };
    const error = await createSigningAttestor(signer)
      .attest(draft(), DOMAIN)
      .then(
        () => null,
        e => e as OracleError,
      );
    expect(error?.code).toBe("ATTESTATION_FAILED");
    expect(JSON.stringify(error?.failure)).not.toContain("secret-abc123");
  });

  it("eip712Domain matches what the attestor signs against (sanity: shared code, not a private copy)", () => {
    expect(eip712Domain(DOMAIN).verifyingContract).toBe(DOMAIN.verifyingContract);
  });
});

import { describe, expect, it } from "vitest";
import { TypedDataEncoder, keccak256, toUtf8Bytes } from "ethers";
import {
  CREDENTIAL_EVENT_TYPES,
  CREDENTIAL_EVENT_TYPE_STRING,
  CREDENTIAL_KEY_TAG,
  CREDENTIAL_MESSAGE_KIND,
  CREDENTIAL_REVOCATION_TYPES,
  CREDENTIAL_REVOCATION_TYPE_STRING,
  buildCredentialMessage,
  computeCredentialId,
  decodeCredentialMessage,
  encodeCredentialMessage,
  validateCredentialEvent,
} from "./credential-envelope";
import {
  CREDENTIAL_ID,
  DOMAIN,
  ISSUER_SIGNER,
  STRANGER,
  b32,
  makeCredentialEvent,
  makeRevocation,
  signIssuance,
  signRevocation,
} from "../audit/test-fixtures";

describe("credential envelope", () => {
  it("pins the EIP-712 type strings to the SDK types", () => {
    expect(TypedDataEncoder.from(CREDENTIAL_EVENT_TYPES).encodeType("CredentialEvent")).toBe(
      CREDENTIAL_EVENT_TYPE_STRING,
    );
    expect(TypedDataEncoder.from(CREDENTIAL_REVOCATION_TYPES).encodeType("CredentialRevocation")).toBe(
      CREDENTIAL_REVOCATION_TYPE_STRING,
    );
    expect(CREDENTIAL_KEY_TAG).toBe(keccak256(toUtf8Bytes("hedera-verifiable-credentials.credential.v1")));
  });

  it("derives credentialId from issuer and externalCredentialId only", () => {
    const e = makeCredentialEvent();
    expect(computeCredentialId(e.issuer, e.externalCredentialId)).toBe(CREDENTIAL_ID);
    expect(computeCredentialId(b32("other-org"), e.externalCredentialId)).not.toBe(CREDENTIAL_ID);
  });

  it("round-trips an issuance and recovers the signer", async () => {
    const event = makeCredentialEvent();
    const signature = await signIssuance(event);
    const bytes = encodeCredentialMessage({ kind: "issuance", event, signature });
    expect(bytes[0]).toBe(CREDENTIAL_MESSAGE_KIND.issuance);
    expect(bytes.length).toBe(1 + 9 * 32 + 65);

    const decoded = decodeCredentialMessage(bytes, DOMAIN);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value.kind !== "issuance") return;
    expect(decoded.value.event).toEqual(event);
    expect(decoded.value.derived.credentialId).toBe(CREDENTIAL_ID);
    expect(decoded.value.derived.signer).toBe(ISSUER_SIGNER.address.toLowerCase());
  });

  it("round-trips a revocation and recovers the revoker", async () => {
    const revocation = makeRevocation();
    const bytes = encodeCredentialMessage({
      kind: "revocation",
      revocation,
      signature: await signRevocation(revocation, STRANGER),
    });
    expect(bytes[0]).toBe(CREDENTIAL_MESSAGE_KIND.revocation);
    const decoded = decodeCredentialMessage(bytes, DOMAIN);
    expect(decoded.ok && decoded.value.kind === "revocation" && decoded.value.derived.signer).toBe(
      STRANGER.address.toLowerCase(),
    );
  });

  it("binds the signature to the registry domain", async () => {
    const event = makeCredentialEvent();
    const bytes = encodeCredentialMessage({ kind: "issuance", event, signature: await signIssuance(event) });
    const other = decodeCredentialMessage(bytes, { ...DOMAIN, verifyingContract: `0x${"99".repeat(20)}` });
    expect(other.ok && other.value.derived.signer).not.toBe(ISSUER_SIGNER.address.toLowerCase());
  });

  it("rejects unknown kinds, truncation, trailing bytes and settlement messages", async () => {
    const event = makeCredentialEvent();
    const bytes = encodeCredentialMessage({ kind: "issuance", event, signature: await signIssuance(event) });

    const settlement = Uint8Array.from(bytes);
    settlement[0] = 0x01;
    expect(decodeCredentialMessage(settlement, DOMAIN)).toMatchObject({
      ok: false,
      issues: [{ code: "UNSUPPORTED_VERSION" }],
    });
    expect(decodeCredentialMessage(bytes.slice(0, 50), DOMAIN).ok).toBe(false);
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(decodeCredentialMessage(trailing, DOMAIN).ok).toBe(false);
  });

  it("rejects a malleable (high-s) signature", async () => {
    const event = makeCredentialEvent();
    const signature = await signIssuance(event);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = parseInt(signature.slice(130), 16) === 27 ? "1c" : "1b";
    const highS = `${signature.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${v}`;
    expect(buildCredentialMessage({ kind: "issuance", event, signature: highS }, DOMAIN)).toMatchObject({
      ok: false,
      issues: [{ code: "MALLEABLE_SIGNATURE" }],
    });
  });

  it("reports every structural problem of an event at once", () => {
    const result = validateCredentialEvent({
      ...makeCredentialEvent(),
      version: 2,
      credentialHash: `0x${"00".repeat(32)}`,
      validUntil: 1n,
      submitter: "nope",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(i => i.field).sort()).toEqual(["credentialHash", "submitter", "validUntil", "version"]);
  });
});

import { describe, expect, it } from "vitest";
import { PrivateKey } from "@hashgraph/sdk";
import { findRepositoryRoot, toDerKey } from "./config";
import { renderCertificatePdf } from "./document";
import { sha256Hex } from "./hcs1";
import { encodeAttribute, validateIssueInput } from "./issuer";

const input = {
  certificateId: "8ac3bcc1-0b42-4837-bc4e-069f49d02de2",
  holderName: "Ana Example",
  course: "Solidity Basics",
  issuerName: "Hedera Academy",
  issuedOn: "2026-10-01",
  verificationUrl: "http://localhost:3000/certificate/8ac3bcc1-0b42-4837-bc4e-069f49d02de2",
};

describe("certificate PDF", () => {
  it("is deterministic, so its hash can be recomputed by anyone holding the same file", async () => {
    const [first, second] = await Promise.all([renderCertificatePdf(input), renderCertificatePdf(input)]);
    expect(sha256Hex(first)).toBe(sha256Hex(second));
    expect(Buffer.from(first.subarray(0, 5)).toString()).toBe("%PDF-");
  });

  it("depends on the certificate id, and stays small enough for a handful of HCS messages", async () => {
    const pdf = await renderCertificatePdf(input);
    const other = await renderCertificatePdf({ ...input, certificateId: "another-id" });
    expect(sha256Hex(pdf)).not.toBe(sha256Hex(other));
    expect(pdf.length).toBeLessThan(8_000);
  });

  it("rejects an invalid issue date", async () => {
    await expect(renderCertificatePdf({ ...input, issuedOn: "yesterday" })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("credential attributes", () => {
  it("keeps 32-bit integers as is (predicates compare them) and hashes everything else", () => {
    expect(encodeAttribute("88")).toBe("88");
    expect(encodeAttribute("-5")).toBe("-5");
    expect(encodeAttribute("Ana")).toMatch(/^\d{30,}$/);
    expect(encodeAttribute("4294967296")).not.toBe("4294967296");
  });

  it("validates issuance input", () => {
    const ok = { holderName: "Ana", studentId: "1", course: "Solidity Basics", grade: 88 };
    expect(() => validateIssueInput(ok)).not.toThrow();
    expect(() => validateIssueInput({ ...ok, holderName: " " })).toThrow(/holderName/);
    expect(() => validateIssueInput({ ...ok, grade: 7.5 })).toThrow(/grade/);
  });
});

describe("operator key normalization", () => {
  it("turns raw hex into DER using the curve the account reports", () => {
    const ecdsa = PrivateKey.generateECDSA();
    const raw = `0x${ecdsa.toStringRaw()}`;
    expect(toDerKey(raw, "ECDSA_SECP256K1")).toBe(ecdsa.toStringDer());
    const ed = PrivateKey.generateED25519();
    expect(toDerKey(ed.toStringRaw(), "ED25519")).toBe(ed.toStringDer());
    expect(toDerKey(ed.toStringDer(), null)).toBe(ed.toStringDer());
    expect(() => toDerKey(ed.toStringRaw(), null)).toThrow(/curve/);
  });

  it("finds the repository root from a nested directory", () => {
    expect(findRepositoryRoot(import.meta.dirname)).toBe(findRepositoryRoot(`${import.meta.dirname}/../..`));
  });
});

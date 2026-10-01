import { describe, expect, it } from "vitest";
import { extractCredentialId } from "./credentialId";

const ID = `0x${"11".repeat(32)}`;

describe("extractCredentialId", () => {
  it("accepts a bare credential id", () => {
    expect(extractCredentialId(ID)).toBe(ID);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(extractCredentialId(`  ${ID.toUpperCase()}  `)).toBe(ID);
  });

  it("extracts the id from a scanned /verify/<id> URL", () => {
    expect(extractCredentialId(`https://example.com/verify/${ID}`)).toBe(ID);
  });

  it("extracts the id from a scanned URL with a trailing slash or query string", () => {
    expect(extractCredentialId(`https://example.com/verify/${ID}/`)).toBe(ID);
    expect(extractCredentialId(`https://example.com/verify/${ID}?utm_source=qr`)).toBe(ID);
  });

  it("finds a credential id embedded anywhere in arbitrary scanned text", () => {
    expect(extractCredentialId(`see credential ${ID} for details`)).toBe(ID);
  });

  it("returns null for empty input", () => {
    expect(extractCredentialId("")).toBeNull();
    expect(extractCredentialId("   ")).toBeNull();
  });

  it("returns null for text with no credential id", () => {
    expect(extractCredentialId("not a credential id")).toBeNull();
    expect(extractCredentialId("https://example.com/about")).toBeNull();
  });

  it("returns null for the zero id (not a valid credentialId)", () => {
    expect(extractCredentialId(`0x${"0".repeat(64)}`)).toBeNull();
  });

  it("returns null for a hex string of the wrong length", () => {
    expect(extractCredentialId(`0x${"11".repeat(16)}`)).toBeNull();
  });
});

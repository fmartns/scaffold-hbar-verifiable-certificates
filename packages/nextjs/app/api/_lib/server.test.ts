import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sh/sdk/certificates", () => {
  class CertificateError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    CertificateError,
    CertificateService: class {},
    loadCertificatesConfig: vi.fn(),
    isHolder: (value: unknown) => value === "ana" || value === "bob",
  };
});

const { respond, holderFrom } = await import("./server");
const { CertificateError } = await import("@sh/sdk/certificates");

describe("respond", () => {
  it("returns JSON for a value and passes a Response through", async () => {
    expect(await (await respond(async () => ({ ok: 1 }))).json()).toEqual({ ok: 1 });
    const pdf = new Response("x", { headers: { "Content-Type": "application/pdf" } });
    expect(await respond(async () => pdf)).toBe(pdf);
  });

  it.each([
    ["INVALID_INPUT", 400],
    ["NOT_FOUND", 404],
    ["ISSUER_NOT_INITIALIZED", 409],
    ["PROOF_UNAVAILABLE", 422],
    ["DOCUMENT_INVALID", 422],
    ["LEDGER_WRITE_FAILED", 502],
  ])("maps %s to HTTP %i with its code and message", async (code, status) => {
    const response = await respond(async () => {
      throw new CertificateError(code as never, "explained");
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code, message: "explained" } });
  });

  it("hides the text of unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await respond(async () => {
      throw new Error("HEDERA_OPERATOR_KEY=302e…");
    });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("302e");
  });
});

describe("holderFrom", () => {
  it("accepts only the demo holders", () => {
    expect(holderFrom("ana")).toBe("ana");
    expect(() => holderFrom("mallory")).toThrow(/demo holders/);
  });
});

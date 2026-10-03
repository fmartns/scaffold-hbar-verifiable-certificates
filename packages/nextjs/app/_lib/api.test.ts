import { describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";

describe("api client", () => {
  it("turns an error body into a typed ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { code: "ISSUER_NOT_INITIALIZED", message: "Run yarn issuer:init" } }, { status: 409 }),
      ),
    );
    await expect(api.state()).rejects.toEqual(new ApiError("ISSUER_NOT_INITIALIZED", "Run yarn issuer:init"));
  });

  it("posts JSON and multipart bodies to the certificate routes", async () => {
    const fetchMock = vi.fn(async () => Response.json({ approved: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api.enroll("ana", 123);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/enroll",
      expect.objectContaining({ body: '{"holder":"ana","asOf":123}' }),
    );

    await api.checkDocument("ana", "id/1", new File(["%PDF"], "c.pdf"));
    const [url, init] = fetchMock.mock.lastCall as unknown as [string, RequestInit];
    expect(url).toBe("/api/document-check");
    expect((init.body as FormData).get("certificateId")).toBe("id/1");
    expect(api.documentUrl("id/1")).toBe("/api/certificates/id%2F1/document");
  });

  it("reports a non-JSON failure by status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { status: 502 })),
    );
    await expect(api.revoke("x")).rejects.toThrow("Request failed (HTTP 502).");
  });
});

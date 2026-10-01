// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as audit } from "./audit/route";
import { POST as publish } from "./publish/route";
import { GET as status } from "./status/route";

const CREDENTIAL_ID = `0x${"11".repeat(32)}`;
const SECRET = "cd".repeat(32);

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith("HEDERA_")) vi.stubEnv(name, "");
  vi.stubEnv("HEDERA_OPERATOR_KEY", SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

async function expectRefusal(response: Response) {
  const text = await response.text();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((JSON.parse(text) as { ok: boolean }).ok).toBe(false);
  expect(text).not.toContain(SECRET);
}

describe("issuer console API routes without a configured environment", () => {
  it("POST /api/credentials/publish refuses a body that is not JSON and an unconfigured server", async () => {
    await expectRefusal(
      await publish(new Request("http://localhost/api/credentials/publish", { method: "POST", body: "{" })),
    );
    await expectRefusal(
      await publish(
        new Request("http://localhost/api/credentials/publish", {
          method: "POST",
          body: JSON.stringify({ kind: "issuance" }),
        }),
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("GET /api/credentials/status and /audit answer with a structured error, never a crash", async () => {
    const url = `http://localhost/api/credentials/status?credentialId=${CREDENTIAL_ID}`;
    await expectRefusal(await status(new NextRequest(url)));
    await expectRefusal(await status(new NextRequest("http://localhost/api/credentials/status")));
    await expectRefusal(
      await audit(
        new NextRequest(`http://localhost/api/credentials/audit?credentialId=${CREDENTIAL_ID}&revocationSequence=9`),
      ),
    );
  });
});

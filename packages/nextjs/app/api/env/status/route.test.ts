// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { HederaHealthReport } from "@sh/sdk";
import { fakeHederaNetwork, healthEnv, healthEnvWithoutKey, healthNow } from "@sh/sdk/testing";
import { GET } from "./route";

function configure(env: Record<string, string | undefined>, network = fakeHederaNetwork()) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value ?? "");
  vi.stubGlobal("fetch", network.fetch);
  vi.useFakeTimers({ now: healthNow(), toFake: ["Date"] });
}

describe("GET /api/env/status", () => {
  it("returns the health report as uncached JSON", async () => {
    configure(healthEnvWithoutKey);

    const response = await GET();
    const report = (await response.json()) as HederaHealthReport;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(report.overall).toBe("ok");
    expect(report.checkedAt).toBe(healthNow().toISOString());
  });

  it("reports a broken environment as statuses, never as a server error, and never echoes the key", async () => {
    configure({ ...healthEnv, HEDERA_NETWORK: "devnet" });

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect((JSON.parse(body) as HederaHealthReport).overall).toBe("error");
    expect(body).not.toContain(healthEnv.HEDERA_OPERATOR_KEY);
  });
});

// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const ADDRESS = `0x${"AB".repeat(20)}`;

function mirror(answer: () => Response) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return answer();
    }),
  );
  return urls;
}

const request = (query: string) => new NextRequest(`http://localhost/api/wallet/account${query}`);

describe("GET /api/wallet/account", () => {
  it("resolves an EVM address to its Hedera account through the configured Mirror Node", async () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    const urls = mirror(() => new Response(JSON.stringify({ account: "0.0.4321" })));

    const response = await GET(request(`?address=${ADDRESS}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "found",
      accountId: "0.0.4321",
      hashscanUrl: "https://hashscan.io/testnet/account/0.0.4321",
    });
    expect(urls[0]).toContain(`/api/v1/accounts/${ADDRESS.toLowerCase()}`);
  });

  it.each([
    ["missing", ""],
    ["malformed", "?address=0x123"],
  ])("rejects a %s address with 400 without calling the Mirror Node", async (_case, query) => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    const urls = mirror(() => new Response("{}"));

    const response = await GET(request(query));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "invalid" });
    expect(urls).toEqual([]);
  });

  it.each([
    ["an address without an account", () => new Response("{}", { status: 404 }), "not_found"],
    ["a Mirror Node error", () => new Response("{}", { status: 503 }), "unavailable"],
  ])("answers 200 for %s", async (_case, answer, status) => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    mirror(answer);

    const response = await GET(request(`?address=${ADDRESS}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status });
  });
});

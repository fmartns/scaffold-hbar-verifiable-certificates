import { Interface } from "ethers";
import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { HtsError } from "./errors";
import { createRouterStatusReader } from "./router-status";
import { CONTENT_HASH, EVENT_KEY, ROUTER_ADDRESS } from "./test-fixtures";

const iface = new Interface([
  "function statusOf(bytes32 eventKey) view returns (bool settled, bytes32 contentHash, uint64 settledAt)",
]);
const reader = (
  handler: (body: { method: string; params: { to: string; data: string }[] }) => Response | Promise<Response>,
) => {
  const calls: unknown[] = [];
  const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body);
    return handler(body);
  }) as typeof fetch;
  return {
    statusReader: createRouterStatusReader({
      network: NETWORKS.testnet,
      routerAddress: ROUTER_ADDRESS,
      fetch: fetchImpl,
    }),
    calls,
  };
};
const result = (settled: boolean, hash: string, at: number) =>
  new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: iface.encodeFunctionResult("statusOf", [settled, hash, at]) }),
  );

describe("createRouterStatusReader", () => {
  it("asks the router's statusOf(eventKey) through eth_call and decodes the answer", async () => {
    const { statusReader, calls } = reader(() => result(true, CONTENT_HASH, 1767225600));
    expect(await statusReader.statusOf(EVENT_KEY)).toEqual({
      settled: true,
      contentHash: CONTENT_HASH,
      settledAt: 1767225600n,
    });
    expect(calls[0]).toMatchObject({
      method: "eth_call",
      params: [{ to: ROUTER_ADDRESS, data: iface.encodeFunctionData("statusOf", [EVENT_KEY]) }, "latest"],
    });
  });

  it("reports an unsettled event", async () => {
    const { statusReader } = reader(() => result(false, `0x${"00".repeat(32)}`, 0));
    expect(await statusReader.statusOf(EVENT_KEY)).toMatchObject({ settled: false, settledAt: 0n });
  });

  it.each([
    ["an HTTP error", () => new Response("", { status: 502 })],
    ["a revert", () => new Response(JSON.stringify({ error: { code: 3, message: "execution reverted" } }))],
    ["an empty result", () => new Response(JSON.stringify({ result: "0x" }))],
    ["a network failure", () => Promise.reject(new Error("connect ECONNREFUSED secret-host"))],
  ])("normalizes %s into NETWORK_UNAVAILABLE / not_sent", async (_, handler) => {
    const error = await reader(handler)
      .statusReader.statusOf(EVENT_KEY)
      .catch(e => e);
    expect(error).toBeInstanceOf(HtsError);
    expect(error.failure).toMatchObject({ code: "NETWORK_UNAVAILABLE", outcome: "not_sent", retryable: true });
    expect(JSON.stringify(error.failure)).not.toContain("secret-host");
  });
});

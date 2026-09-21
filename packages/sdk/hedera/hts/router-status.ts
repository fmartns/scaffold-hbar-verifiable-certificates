/**
 * Reads `SettlementRouter.statusOf(eventKey)` (ADR §6.4) over the JSON-RPC relay, so the adapter can ask the AUTHORITY
 * whether an event is already settled before it sends anything (recovery invariant, ADR §5.5).
 * `statusOf(bytes32) returns (bool settled, bytes32 contentHash, uint64 settledAt)`.
 */
import { Interface } from "ethers";
import type { HederaNetwork } from "../networks";
import { HtsError } from "./errors";
import type { SettlementStatusReader } from "./types";

const ROUTER_STATUS = new Interface([
  "function statusOf(bytes32 eventKey) view returns (bool settled, bytes32 contentHash, uint64 settledAt)",
]);

export function createRouterStatusReader(options: {
  network: HederaNetwork;
  routerAddress: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SettlementStatusReader {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const unavailable = (detail: string) =>
    new HtsError({
      code: "NETWORK_UNAVAILABLE",
      outcome: "not_sent",
      operation: "preflight",
      message: `Could not read the settlement status from the router (${detail}).`,
      remediation:
        "Check HEDERA_RPC_URL and that the SettlementRouter is deployed at HEDERA_SETTLEMENT_ROUTER_ADDRESS, then retry. Nothing was sent.",
      retryable: true,
    });

  return {
    async statusOf(eventKey) {
      let body: { result?: string; error?: unknown };
      try {
        const response = await fetchImpl(options.network.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
              { to: options.routerAddress, data: ROUTER_STATUS.encodeFunctionData("statusOf", [eventKey]) },
              "latest",
            ],
          }),
        });
        if (!response.ok) throw unavailable(`HTTP ${response.status}`);
        body = (await response.json()) as typeof body;
      } catch (error) {
        throw error instanceof HtsError ? error : unavailable("network error");
      }
      if (typeof body.result !== "string" || body.error) throw unavailable("the call reverted or returned nothing");
      try {
        const [settled, contentHash, settledAt] = ROUTER_STATUS.decodeFunctionResult("statusOf", body.result);
        return { settled: Boolean(settled), contentHash: String(contentHash), settledAt: BigInt(settledAt) };
      } catch {
        throw unavailable("malformed answer");
      }
    },
  };
}

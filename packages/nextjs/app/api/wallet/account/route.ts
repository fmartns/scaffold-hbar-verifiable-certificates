import type { NextRequest } from "next/server";
import { lookupEvmAccount } from "@sh/sdk";

export const dynamic = "force-dynamic";

/** Hedera account id of a wallet's EVM address, resolved server-side through the configured Mirror Node. */
export async function GET(request: NextRequest) {
  const result = await lookupEvmAccount(process.env, request.nextUrl.searchParams.get("address") ?? "");
  return Response.json(result, {
    status: result.status === "invalid" ? 400 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

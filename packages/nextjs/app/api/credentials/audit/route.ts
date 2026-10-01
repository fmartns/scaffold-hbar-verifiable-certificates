import type { NextRequest } from "next/server";
import { handleCredentialAudit } from "@sh/sdk";

export const dynamic = "force-dynamic";

/** The shared credential audit report (#10): contract state and logs correlated with the HCS evidence. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const { status, body } = await handleCredentialAudit(params.get("credentialId") ?? "", {
    env: process.env,
    revocationHcsSequence: params.get("revocationSequence") ?? undefined,
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

import type { NextRequest } from "next/server";
import { handleCredentialStatus } from "@sh/sdk";

export const dynamic = "force-dynamic";

/** `CredentialRegistry.statusOf(credentialId)`, the authority on a credential's state. */
export async function GET(request: NextRequest) {
  const { status, body } = await handleCredentialStatus(request.nextUrl.searchParams.get("credentialId") ?? "", {
    env: process.env,
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

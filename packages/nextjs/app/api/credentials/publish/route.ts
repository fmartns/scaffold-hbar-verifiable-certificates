import { handlePublishCredential } from "@sh/sdk";

export const dynamic = "force-dynamic";

/**
 * Publishes a signed credential issuance or revocation to the HCS evidence topic with the operator key (server-side
 * only) and returns the consensus receipt. Refuses anything not signed by an active registered issuer's signer.
 */
export async function POST(request: Request) {
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const { status, body: payload } = await handlePublishCredential(body, { env: process.env });
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

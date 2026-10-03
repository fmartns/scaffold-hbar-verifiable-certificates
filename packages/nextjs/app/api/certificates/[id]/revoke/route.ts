import { toRegisterEntry } from "@sh/sdk/certificates";
import { certificateService, respond } from "../../../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revokes a certificate: one message on the issuer's revocation entries topic. The PDF stays where it is. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(async () => toRegisterEntry(await (await certificateService()).revoke(id)));
}

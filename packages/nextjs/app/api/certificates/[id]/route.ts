import { certificateService, respond } from "../../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public view of a certificate (what the QR code leads to): no grade, no student id, document integrity re-checked. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(async () => (await certificateService()).publicCertificate(id));
}

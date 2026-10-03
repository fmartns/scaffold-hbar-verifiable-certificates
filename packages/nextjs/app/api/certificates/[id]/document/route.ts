import { certificateService, respond } from "../../../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The certificate PDF, rebuilt from its HCS-1 topic via the Mirror Node and checked against the memo hash. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return respond(async () => {
    const pdf = await (await certificateService()).document(id);
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="certificate-${id}.pdf"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });
}

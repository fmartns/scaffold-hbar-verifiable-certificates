import { readFile } from "node:fs/promises";
import path from "node:path";
import { CertificateError, LocalTailsFileService } from "@sh/sdk/certificates";
import { certificateService, respond } from "../../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * AnonCreds tails files, addressed by hash (the `tailsLocation` of the revocation registry on Hedera). Holders download
 * them to build non-revocation proofs; the content is public and integrity-checked by its hash.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return respond(async () => {
    const { config } = await certificateService();
    let file: Buffer;
    try {
      file = await readFile(LocalTailsFileService.pathFor(path.join(config.dataDir, "tails"), hash));
    } catch {
      throw new CertificateError("NOT_FOUND", "Unknown tails file.");
    }
    return new Response(new Uint8Array(file), {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=31536000, immutable" },
    });
  });
}

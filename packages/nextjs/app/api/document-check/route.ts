import { CertificateError } from "@sh/sdk/certificates";
import { certificateService, holderFrom, respond } from "../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 1_000_000;

/** Platform B checks an uploaded PDF against the holder's proof: same SHA-256, and is the credential still valid? */
export function POST(request: Request) {
  return respond(async () => {
    const form = await request.formData().catch(() => {
      throw new CertificateError("INVALID_INPUT", "Body must be multipart form data.");
    });
    const file = form.get("file");
    const certificateId = form.get("certificateId");
    if (!(file instanceof Blob) || file.size === 0 || file.size > MAX_BYTES) {
      throw new CertificateError("INVALID_INPUT", "Attach the certificate PDF (up to 1 MB).");
    }
    if (typeof certificateId !== "string" || certificateId.length === 0) {
      throw new CertificateError("INVALID_INPUT", "certificateId is required.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return (await certificateService()).checkDocument(holderFrom(form.get("holder")), certificateId, bytes);
  });
}

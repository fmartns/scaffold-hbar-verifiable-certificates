import { CertificateError, toRegisterEntry } from "@sh/sdk/certificates";
import { certificateService, holderFrom, respond } from "../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Issues a certificate to a demo holder: PDF on HCS-1, then the AnonCreds credential into the holder's wallet. */
export function POST(request: Request) {
  return respond(async () => {
    const body = await request.json().catch(() => {
      throw new CertificateError("INVALID_INPUT", "Body must be JSON.");
    });
    const record = await (
      await certificateService()
    ).issue(holderFrom(body.holder), {
      holderName: body.holderName,
      studentId: body.studentId,
      course: body.course,
      grade: Number(body.grade),
    });
    return toRegisterEntry(record);
  });
}

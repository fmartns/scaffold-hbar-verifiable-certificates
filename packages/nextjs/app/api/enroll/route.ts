import { CertificateError } from "@sh/sdk/certificates";
import { certificateService, holderFrom, respond } from "../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Platform B decides on enrollment in Advanced Solidity. `asOf` (Unix seconds, optional) asks "was the prerequisite
 * valid at that time?" instead of "now".
 */
export function POST(request: Request) {
  return respond(async () => {
    const body = await request.json().catch(() => {
      throw new CertificateError("INVALID_INPUT", "Body must be JSON.");
    });
    const now = Math.floor(Date.now() / 1000);
    const asOf = body.asOf === undefined ? now : Number(body.asOf);
    if (!Number.isInteger(asOf) || asOf <= 0 || asOf > now) {
      throw new CertificateError("INVALID_INPUT", "asOf must be a past Unix time in seconds.");
    }
    return (await certificateService()).enroll(holderFrom(body.holder), asOf);
  });
}

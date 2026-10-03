import { certificateService, respond } from "../../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The accreditation authority withdraws the demo issuer's accreditation (one contract call). Certificates stay valid
 * AnonCreds credentials, but Platform B stops accepting them for enrollment from now on; "as of" earlier still passes.
 */
export function POST() {
  return respond(async () => (await certificateService()).withdrawAccreditation());
}

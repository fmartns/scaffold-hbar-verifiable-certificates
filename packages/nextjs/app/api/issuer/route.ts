import { certificateService, respond } from "../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publishes the issuer and the accreditation registry on Hedera (idempotent). Same as `yarn issuer:init --yes`. */
export function POST() {
  return respond(async () => (await certificateService()).initialize());
}

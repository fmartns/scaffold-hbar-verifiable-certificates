import { certificateService, respond } from "../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Publishes the issuer on Hedera (idempotent). Same operation as `yarn issuer:init --yes`. */
export function POST() {
  return respond(async () => (await certificateService()).initializeIssuer());
}

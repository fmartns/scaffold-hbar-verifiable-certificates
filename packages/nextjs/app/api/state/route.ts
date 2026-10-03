import { ENROLLMENT_POLICY, HOLDERS, ISSUER_NAME, toRegisterEntry } from "@sh/sdk/certificates";
import { certificateService, respond } from "../_lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything the console shows: public issuer identifiers and the certificate register (no grades, no student ids). */
export function GET() {
  return respond(async () => {
    const service = await certificateService();
    const [issuer, certificates] = await Promise.all([service.store.readIssuer(), service.store.listCertificates()]);
    const current = issuer?.network === service.config.network ? issuer : null;
    return {
      network: service.config.network,
      hashscanUrl: service.config.hashscanUrl,
      mirrorNodeUrl: service.config.mirrorNodeUrl,
      issuerName: ISSUER_NAME,
      issuer: current,
      holders: HOLDERS,
      policy: ENROLLMENT_POLICY,
      certificates: certificates.map(toRegisterEntry),
    };
  });
}

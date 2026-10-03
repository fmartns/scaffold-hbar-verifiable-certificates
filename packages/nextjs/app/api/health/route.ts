import path from "node:path";
import { CERTIFICATE_ENV, CertificateStore, findRepositoryRoot } from "@sh/sdk/certificates";
import { selectedNetworkName } from "@sh/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness and setup state, without network calls or secrets: always 200 while the server runs, so it works in CI with
 * no `.env`. `yarn setup` is the full environment check.
 */
export async function GET() {
  let network: string;
  try {
    network = selectedNetworkName(process.env);
  } catch {
    network = "invalid";
  }
  const store = new CertificateStore(
    path.resolve(findRepositoryRoot(), process.env[CERTIFICATE_ENV.DATA_DIR] || ".data"),
  );
  const [issuer, accreditation] = await Promise.all([
    store.readIssuer().catch(() => null),
    store.readAccreditation().catch(() => null),
  ]);
  return Response.json({
    status: "ok",
    network,
    operatorConfigured: Boolean(process.env.HEDERA_OPERATOR_ID && process.env.HEDERA_OPERATOR_KEY),
    issuerPublished: issuer?.network === network,
    accreditationPublished: accreditation?.network === network,
  });
}

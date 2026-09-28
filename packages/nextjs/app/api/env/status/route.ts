import { checkHederaHealth } from "@sh/sdk";

export const dynamic = "force-dynamic";

/** The dashboard's report as JSON, for scripts and the CI self-check. Secret-free by construction (tested in the SDK). */
export async function GET() {
  const report = await checkHederaHealth(process.env);
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}

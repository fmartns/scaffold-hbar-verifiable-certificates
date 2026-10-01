/**
 * `yarn demo:event-attendance`: runs the full "Event Attendance Certificate" example end to end, offline (#42).
 *
 * This is a seed/demo built *on top of* the generic credential core, never the other way around: it is the only file
 * in this module that knows the word "event". It issues one real credential of the `event-attendance` schema preset
 * (`CREDENTIAL_SCHEMA_PRESETS[0]`, `packages/sdk/hedera/credentials/fields.ts`) through the production issuer flow
 * (`runIssuance`, which fixes the ADR D11 order: HCS consensus receipt before the registry transaction), reads it
 * back through the exact handler the public verifier's API route calls (`handleCredentialStatus`), revokes it
 * through the production revocation flow (`runRevocation`), and reads it back again. Nothing here re-implements
 * credential derivation, the issuer flow or the server handlers: it only wires the existing, real implementations to
 * a deterministic in-memory Hedera (`@sh/sdk/testing`'s `fakeTestnet`) instead of a real network, so the whole cycle
 * runs in one command with no `.env`, no credentials and no network access, and produces the same shape of evidence
 * (credentialId, HCS receipt, registry transaction, CredentialStatusView) a real run would.
 *
 * This is why the file is the one deliberate exception allowed to import `@sh/sdk/testing` outside a test (see
 * `packages/sdk/eslint.config.mjs`): it is dev/demo-only, isolated, and could be deleted without affecting anything
 * else in the template (the acceptance criterion of #42).
 *
 * For evidence against the real Hedera Testnet (with real HashScan links), see `yarn verify:testnet` instead
 * (docs/testnet-validation.md). This script's HashScan-shaped URLs are illustrative only: the network behind them is
 * fake, so the links do not resolve.
 *
 * Narrative (docs/demo-event-attendance.md): the organizer (issuer) issues a credential for a hackathon attendee,
 * generates a QR code of the credential id, a participant "scans" it and the verifier shows ACTIVE, the organizer
 * revokes it, the participant checks again and the verifier shows REVOKED.
 */
import { Wallet } from "ethers";
import QRCode from "qrcode";
import { IssuerFlowError } from "../hedera/credentials/errors";
import { CREDENTIAL_SCHEMA_PRESETS } from "../hedera/credentials/fields";
import type { CredentialDraftInput } from "../hedera/credentials/fields";
import { runIssuance, runRevocation } from "../hedera/credentials/issuer-flow";
import type {
  CredentialPublishReceipt,
  CredentialStatusView,
  IssuanceOutcome,
  IssuerBackend,
  IssuerFlowContext,
  RegistryTransaction,
  RevocationOutcome,
} from "../hedera/credentials/issuer-flow";
import { computeIssuerId } from "../hedera/credentials/schema";
import { handleCredentialStatus, handlePublishCredential } from "../hedera/credentials/server";
import type { HandlerResponse, ServerDeps } from "../hedera/credentials/server";
import type { Hex } from "../hedera/hcs/envelope";
import { NETWORKS } from "../hedera/networks";
import { createRelayWallet } from "../hedera/testnet/relay-wallet";
import { fakeTestnet, testnetEnv } from "../testing";
import type { FakeTestnetOptions } from "../testing";

// ---------------------------------------------------------------------------------------------------------------------
// The example: a hackathon organizer issuing an attendance credential to a participant
// ---------------------------------------------------------------------------------------------------------------------

/** Throwaway demo key: it signs on the in-memory fake network only. Never reuse it for anything real. */
const DEMO_ORGANIZER_PRIVATE_KEY = `0x${"7e".repeat(32)}`;
const DEMO_ISSUER_NAME = "hedera-hackathon-sp-2026";
const DEMO_PARTICIPANT_EMAIL = "alice@example.com";

const EVENT_ATTENDANCE_PRESET = CREDENTIAL_SCHEMA_PRESETS.find(p => p.descriptor.startsWith("event-attendance."));

export function demoDraftInput(now: Date): CredentialDraftInput {
  if (!EVENT_ATTENDANCE_PRESET) throw new Error("the event-attendance schema preset is missing");
  const isoToday = now.toISOString().slice(0, 10);
  return {
    issuerName: DEMO_ISSUER_NAME,
    schema: EVENT_ATTENDANCE_PRESET.descriptor,
    reference: "HH-2026-ATT-000123",
    subjectIdType: "email",
    subjectIdValue: DEMO_PARTICIPANT_EMAIL,
    issuedOn: isoToday,
    expiresOn: "",
    claims: { eventName: "Hedera Hackathon São Paulo 2026", eventDate: "2026-09-12", role: "participant" },
    validitySeconds: 600,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Wiring: the production issuer flow and server handlers, against the shared fake Hedera
// ---------------------------------------------------------------------------------------------------------------------

export interface DemoWorld {
  fake: ReturnType<typeof fakeTestnet>;
  deps: ServerDeps;
  ctx: IssuerFlowContext;
  organizerAddress: Hex;
}

function unwrap<T>(response: HandlerResponse<T>): T {
  if (!response.body.ok) throw new IssuerFlowError(response.body.error);
  return response.body.value;
}

/** Builds the in-memory fake Hedera, the organizer's wallet and the issuer-flow context that drives it. */
export function buildDemoWorld(options: FakeTestnetOptions = {}): DemoWorld {
  const organizerAddress = new Wallet(DEMO_ORGANIZER_PRIVATE_KEY).address.toLowerCase() as Hex;
  const issuerId = computeIssuerId(DEMO_ISSUER_NAME);
  const fake = fakeTestnet({
    ...options,
    issuers: { ...options.issuers, [issuerId]: { signer: organizerAddress } },
  });
  // The relay wallet signs locally and posts every other method through the fake network's relay (`fake.fetch`),
  // never a real one.
  const organizerWallet = createRelayWallet({
    privateKey: DEMO_ORGANIZER_PRIVATE_KEY,
    rpcUrl: NETWORKS.testnet.rpcUrl,
    chainId: NETWORKS.testnet.chainId,
    fetch: fake.fetch,
  });

  const deps: ServerDeps = {
    env: testnetEnv,
    fetch: fake.fetch,
    transport: fake.topic.transport,
    now: () => new Date(fake.clock.now()),
  };

  const backend: IssuerBackend = {
    publish: request => handlePublishCredential(request, deps).then(unwrap),
    status: credentialId => handleCredentialStatus(credentialId, deps).then(unwrap),
  };

  const ctx: IssuerFlowContext = {
    provider: organizerWallet,
    backend,
    chainId: NETWORKS.testnet.chainId,
    registryAddress: testnetEnv.HEDERA_CREDENTIAL_REGISTRY_ADDRESS,
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    receiptPollMs: 10,
  };

  return { fake, deps, ctx, organizerAddress: organizerWallet.address };
}

// ---------------------------------------------------------------------------------------------------------------------
// The six-step cycle
// ---------------------------------------------------------------------------------------------------------------------

export interface DemoResult {
  credentialId: Hex;
  verifyPath: string;
  qrCodeDataUrl: string;
  qrCodeTerminal: string;
  issuance: { outcome: IssuanceOutcome };
  statusAfterIssuance: CredentialStatusView;
  revocation: { outcome: RevocationOutcome };
  statusAfterRevocation: CredentialStatusView;
}

/** Everything the CLI prints, gathered as data first so printing stays separate from the flow (and testable). */
export async function runEventAttendanceDemo(
  world: DemoWorld,
  onLine: (line: string) => void = () => undefined,
): Promise<DemoResult> {
  const now = new Date(world.fake.clock.now());

  onLine(`Organizer "${DEMO_ISSUER_NAME}" issues an event-attendance credential for ${DEMO_PARTICIPANT_EMAIL}...`);
  const issuance = await runIssuance(demoDraftInput(now), world.ctx, event => {
    if (event.state === "done") onLine(`  ${event.step}: done`);
  });
  onLine(`  credentialId = ${issuance.credentialId}`);
  onLine(`  HCS evidence: topic ${issuance.hcs.topicId}, sequence ${issuance.hcs.hcsRef.sequence}`);
  onLine(`  Registry transaction: ${issuance.registration.transactionHash}`);

  const verifyPath = `/verify/${issuance.credentialId}`;
  const qrCodeDataUrl = await QRCode.toDataURL(issuance.credentialId, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 192,
  });
  const qrCodeTerminal = await QRCode.toString(issuance.credentialId, { type: "terminal", small: true });
  onLine(`QR code generated for the credential id (same encoding the issuer console uses):`);
  onLine(qrCodeTerminal);
  onLine(`Verification link: ${verifyPath}`);

  onLine("Participant scans the QR code and checks the verifier's read path (GET /api/credentials/status)...");
  const statusAfterIssuance = unwrap(await handleCredentialStatus(issuance.credentialId, world.deps));
  onLine(`  status = ${statusAfterIssuance.status === "issued" ? "ACTIVE" : statusAfterIssuance.status}`);

  onLine("Organizer revokes the credential...");
  const revocation = await runRevocation(
    { credentialId: issuance.credentialId, reason: "superseded" },
    world.ctx,
    event => {
      if (event.state === "done") onLine(`  ${event.step}: done`);
    },
  );
  onLine(`  Registry transaction: ${revocation.registration.transactionHash}`);

  onLine("Participant checks the verifier again...");
  const statusAfterRevocation = unwrap(await handleCredentialStatus(issuance.credentialId, world.deps));
  onLine(`  status = ${statusAfterRevocation.status === "revoked" ? "REVOKED" : statusAfterRevocation.status}`);

  return {
    credentialId: issuance.credentialId,
    verifyPath,
    qrCodeDataUrl,
    qrCodeTerminal,
    issuance: { outcome: issuance },
    statusAfterIssuance,
    revocation: { outcome: revocation },
    statusAfterRevocation,
  };
}

// Re-exported so a caller (or a test) that only needs the receipt shapes does not have to reach into `issuer-flow`.
export type { CredentialPublishReceipt, RegistryTransaction };

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  console.log("Event Attendance Certificate demo (#42) — offline, deterministic, no .env and no network needed.\n");
  const world = buildDemoWorld();
  const result = await runEventAttendanceDemo(world, line => console.log(line));
  console.log("");
  console.log(
    result.statusAfterIssuance.status === "issued" && result.statusAfterRevocation.status === "revoked"
      ? "ok    issue -> QR -> verify ACTIVE -> revoke -> verify REVOKED, all passed."
      : "x     unexpected status; see docs/demo-event-attendance.md.",
  );
  process.exitCode =
    result.statusAfterIssuance.status === "issued" && result.statusAfterRevocation.status === "revoked" ? 0 : 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error("The demo failed unexpectedly:", error);
    process.exitCode = 1;
  });
}

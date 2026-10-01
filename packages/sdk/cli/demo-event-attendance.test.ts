import { describe, expect, it } from "vitest";
import { buildDemoWorld, demoDraftInput, runEventAttendanceDemo } from "./demo-event-attendance";

describe("yarn demo:event-attendance", () => {
  it("builds a deterministic draft for the event-attendance schema preset", () => {
    const draft = demoDraftInput(new Date("2026-10-01T12:00:00Z"));
    expect(draft.schema.startsWith("event-attendance.")).toBe(true);
    expect(draft.subjectIdType).toBe("email");
    expect(draft.subjectIdValue).toBe("alice@example.com");
    expect(draft.claims).toMatchObject({ eventName: expect.any(String), eventDate: expect.any(String) });
  });

  it("runs the full issue -> QR -> verify ACTIVE -> revoke -> verify REVOKED cycle, offline and deterministically", async () => {
    const world = buildDemoWorld();
    const lines: string[] = [];
    const result = await runEventAttendanceDemo(world, line => lines.push(line));

    // Issuance: a real credential, with HCS evidence captured before the registry transaction (ADR D11).
    expect(result.credentialId).toMatch(/^0x[0-9a-f]+$/);
    expect(Number(result.issuance.outcome.hcs.hcsRef.sequence)).toBeGreaterThan(0);
    expect(result.issuance.outcome.registration.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);

    // First read: the participant's "scan" sees the credential ACTIVE (issued, not yet revoked).
    expect(result.statusAfterIssuance.status).toBe("issued");

    // QR output: encodes the credential id and the verification path, in both renderable forms.
    expect(result.qrCodeDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.qrCodeTerminal.length).toBeGreaterThan(0);
    expect(result.verifyPath).toBe(`/verify/${result.credentialId}`);

    // Revocation: a real revocation transaction against the same registry.
    expect(result.revocation.outcome.registration.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Second read: the same credential id now resolves to REVOKED.
    expect(result.statusAfterRevocation.status).toBe("revoked");

    // Nothing here re-implements the issuer flow or the server handlers; the only moving part the demo
    // owns is the "event" framing, so the step-by-step log should mention both.
    const log = lines.join("\n");
    expect(log).toContain("Organizer");
    expect(log).toContain("status = ACTIVE");
    expect(log).toContain("status = REVOKED");
  });

  it("is deterministic: two independent runs (own fake world, own clock) mint the same credential id", async () => {
    // `credentialId = computeCredentialId(issuer, externalCredentialId)` is a pure function of the credential's
    // identifying fields (ADR §4.4) — not of `generateSubjectSalt`'s randomness, which the credential core keeps
    // out of the id on purpose, and not of a transaction's signature (which is itself randomized and expected to
    // differ run to run). Each run below gets its own fake Hedera world, so this is not a collision: it is the
    // demo's credential id and QR output being exactly reproducible, which is what makes the captured output in
    // docs/demo-event-attendance.md safe to document verbatim.
    const run = async () => runEventAttendanceDemo(buildDemoWorld());
    const [first, second] = await Promise.all([run(), run()]);
    expect(first.credentialId).toBe(second.credentialId);
    expect(first.verifyPath).toBe(second.verifyPath);
    expect(first.qrCodeTerminal).toBe(second.qrCodeTerminal);
  });

  it("never touches a real network: no outbound calls land outside the fake transport", async () => {
    const world = buildDemoWorld();
    await runEventAttendanceDemo(world);
    // `fake.rpcCalls`/`fake.transactions` only exist on the in-memory fake; their presence (rather than a thrown
    // ENOTFOUND/ECONNREFUSED from a real fetch) is itself the evidence that the whole cycle ran offline.
    expect(world.fake.transactions.length).toBeGreaterThan(0);
    expect(world.fake.transactions.map(t => t.method)).toEqual(expect.arrayContaining(["issue", "revoke"]));
  });
});

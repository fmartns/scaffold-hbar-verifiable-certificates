import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CREDENTIAL_ID, auditReport } from "../../issuer/_components/test-utils";
import { EvidenceSection } from "./EvidenceSection";

afterEach(cleanup);

describe("EvidenceSection", () => {
  it("frames and renders the shared audit report (#10), without re-implementing the correlation it shows", async () => {
    render(<EvidenceSection credentialId={CREDENTIAL_ID} fetchAudit={async () => auditReport()} />);
    expect(screen.getByText(/independent evidence trail/)).toBeTruthy();
    expect(await screen.findByText("On-chain: issued")).toBeTruthy();
    expect(screen.getByText("Evidence consistent")).toBeTruthy();
  });
});

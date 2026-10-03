import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConsoleState, Decision } from "../_lib/api";

const enroll = vi.fn();
vi.mock("../_lib/api", () => ({ api: { enroll: (...args: unknown[]) => enroll(...args) } }));
const { PlatformPanel } = await import("./PlatformPanel");

const state: ConsoleState = {
  network: "testnet",
  hashscanUrl: "https://hashscan.io/testnet",
  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
  issuerName: "Hedera Academy",
  issuer: { credentialDefinitionId: "cd" } as ConsoleState["issuer"],
  holders: ["ana", "bob"],
  policy: { offering: "Advanced Solidity", prerequisite: "Solidity Basics", minimumGrade: 70 },
  certificates: [],
};

const request = {
  name: "Enrollment",
  version: "1.0",
  nonce: "1",
  requested_attributes: { course: { name: "course" } },
  requested_predicates: { grade: { name: "grade", p_type: ">=", p_value: 70 } },
  non_revoked: { from: 1790997772, to: 1790997772 },
} as unknown as Decision["request"];

const run = async (_label: string, action: () => Promise<unknown>) => {
  await action();
};

describe("PlatformPanel", () => {
  it("shows what Platform B asked for, received and never received", async () => {
    enroll.mockResolvedValueOnce({
      approved: true,
      reasons: [],
      request,
      verification: {
        verified: true,
        revealed: { course: "Solidity Basics" },
        predicates: ["grade >= 70"],
        resolved: [],
      },
    } satisfies Decision);
    render(<PlatformPanel state={state} run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "ana applies" }));

    await waitFor(() => expect(screen.getByText("ENROLLED")).toBeTruthy());
    expect(enroll).toHaveBeenCalledWith("ana", undefined);
    const card = screen.getByRole("article", { name: /ana → Advanced Solidity/ });
    expect(card.textContent).toContain("course = Solidity Basics");
    expect(card.textContent).toContain("not revoked at 2026-10-03T03:22:52Z");
    expect(card.textContent).toContain("Never shared: holder_name, student_id, grade (the value), document_sha256");
  });

  it("explains a denial without a proof", async () => {
    enroll.mockResolvedValueOnce({ approved: false, reasons: ["The holder has no certificate to present."], request });
    render(<PlatformPanel state={state} run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "bob applies" }));

    await waitFor(() => expect(screen.getByText("DENIED")).toBeTruthy());
    expect(screen.getByText("No proof was presented.")).toBeTruthy();
    expect(screen.getByText("The holder has no certificate to present.")).toBeTruthy();
  });

  it("asks about a past time in UTC seconds", async () => {
    enroll.mockResolvedValueOnce({ approved: true, reasons: [], request });
    render(<PlatformPanel state={state} run={run} />);
    fireEvent.change(screen.getByLabelText(/Was it valid at/), { target: { value: "2026-10-03T03:22:52" } });
    fireEvent.click(screen.getByRole("button", { name: "Check ana at that time" }));
    await waitFor(() => expect(enroll).toHaveBeenCalledWith("ana", 1790997772));
  });
});

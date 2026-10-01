import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VerifyEntry } from "./VerifyEntry";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let onScannedHandler: ((value: string) => void) | null = null;
vi.mock("./QrScanner", () => ({
  QrScanner: ({ onScanned }: { onScanned: (value: string) => void }) => {
    onScannedHandler = onScanned;
    return null;
  },
}));

const CREDENTIAL_ID = `0x${"11".repeat(32)}`;

afterEach(() => {
  cleanup();
  push.mockClear();
  onScannedHandler = null;
});

describe("VerifyEntry", () => {
  it("navigates to the result page when a valid credential id is typed", () => {
    render(<VerifyEntry />);
    fireEvent.change(screen.getByLabelText("Credential id"), { target: { value: CREDENTIAL_ID } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(push).toHaveBeenCalledWith(`/verify/${CREDENTIAL_ID}`);
  });

  it("shows a specific message instead of navigating when the input is not a credential id", () => {
    render(<VerifyEntry />);
    fireEvent.change(screen.getByLabelText("Credential id"), { target: { value: "not an id" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("does not look like a credential id");
  });

  it("navigates directly to the result when the QR scanner reports a scanned value", () => {
    render(<VerifyEntry />);
    expect(onScannedHandler).toBeTruthy();
    onScannedHandler?.(`https://example.com/verify/${CREDENTIAL_ID}`);
    expect(push).toHaveBeenCalledWith(`/verify/${CREDENTIAL_ID}`);
  });
});

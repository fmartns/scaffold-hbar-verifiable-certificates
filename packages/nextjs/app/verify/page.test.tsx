import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import VerifyIndexPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(cleanup);

describe("/verify", () => {
  it("renders the entry point with no wallet or login required", () => {
    render(<VerifyIndexPage />);
    expect(screen.getByRole("heading", { name: "Verify a credential" })).toBeTruthy();
    expect(screen.getByText(/no wallet, no account/)).toBeTruthy();
    expect(screen.getByLabelText("Credential id")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan QR code" })).toBeTruthy();
  });
});

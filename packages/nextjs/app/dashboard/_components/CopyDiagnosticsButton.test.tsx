import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HEALTH_SCENARIOS, HEALTH_SECRET_KEY } from "@sh/sdk/testing";
import { CopyDiagnosticsButton } from "./CopyDiagnosticsButton";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

describe("CopyDiagnosticsButton", () => {
  it("copies the report as JSON, without the operator key, and resets after two seconds", async () => {
    const { report } = await HEALTH_SCENARIOS.healthy();
    vi.useFakeTimers();
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    stubClipboard(writeText);
    render(<CopyDiagnosticsButton report={report} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(screen.getByRole("button").textContent).toBe("Copied");
    const copied = writeText.mock.calls[0][0];
    expect(JSON.parse(copied)).toEqual(report);
    expect(copied).not.toContain(HEALTH_SECRET_KEY);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole("button").textContent).toBe("Copy diagnostics");
  });

  it("reports a clipboard failure", async () => {
    const { report } = await HEALTH_SCENARIOS.healthy();
    stubClipboard(async () => {
      throw new Error("NotAllowedError");
    });
    render(<CopyDiagnosticsButton report={report} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(screen.getByRole("button").textContent).toBe("Copy failed");
  });
});

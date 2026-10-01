import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./CopyButton";

const setClipboard = (writeText: (value: string) => Promise<void>) =>
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

afterEach(() => vi.useRealTimers());

describe("CopyButton", () => {
  it("copies the value, confirms, then resets", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    render(<CopyButton value="0xabc" />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith("0xabc");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
  });

  it("stays unconfirmed when the clipboard is denied", async () => {
    setClipboard(() => Promise.reject(new Error("denied")));
    render(<CopyButton value="0xabc" label="Copy ID" />);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy ID" })));
    expect(screen.getByRole("button", { name: "Copy ID" })).toBeTruthy();
  });
});

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RefreshButton } from "./RefreshButton";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("RefreshButton", () => {
  it("re-runs the server checks through the router", async () => {
    render(<RefreshButton />);
    expect(screen.getByRole("button").textContent).toBe("Re-check");

    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Home from "./page";

describe("Home", () => {
  it("shows the selected network with URLs reduced to their origin", () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    vi.stubEnv("HEDERA_MIRROR_NODE_URL", "https://user:secret@mirror.example.com/api?token=abc");
    render(<Home />);

    expect(screen.getByText("testnet")).toBeTruthy();
    expect(screen.getByText("296")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("secret");
    expect(document.body.innerHTML).not.toContain("token=abc");
    expect(screen.getByRole("link", { name: /Check the environment health/ }).getAttribute("href")).toBe("/dashboard");
  });
});

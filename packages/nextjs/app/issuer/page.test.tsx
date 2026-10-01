import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IssuerPage from "./page";

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith("HEDERA_")) vi.stubEnv(name, "");
});

describe("/issuer", () => {
  it("renders the console disabled, with the missing configuration, when the environment is empty", () => {
    render(<IssuerPage />);
    expect(screen.getByRole("heading", { name: "Issuer console" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Not configured" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Issue credential" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("targets the configured network's wallet chain", () => {
    vi.stubEnv("HEDERA_NETWORK", "testnet");
    render(<IssuerPage />);
    expect(screen.getByRole("heading", { name: "Issuer console" })).toBeTruthy();
  });
});

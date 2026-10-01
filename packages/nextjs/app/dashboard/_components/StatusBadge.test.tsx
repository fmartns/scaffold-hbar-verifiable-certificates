import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge, StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each([
    ["ok", "OK"],
    ["error", "Error"],
    ["not_configured", "Not configured"],
  ] as const)("labels %s as %s", (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByRole("status").textContent).toBe(label);
  });

  it("says Unreachable for a transient (connectivity) error", () => {
    render(<StatusBadge status="error" transient />);
    expect(screen.getByRole("status").textContent).toBe("Unreachable");
  });

  it("ignores transient on a non-error status", () => {
    render(<StatusBadge status="ok" transient />);
    expect(screen.getByRole("status").textContent).toBe("OK");
  });
});

describe("Badge", () => {
  it("renders its children with the tone class", () => {
    render(<Badge tone="warn">LOW_BALANCE</Badge>);
    expect(screen.getByText("LOW_BALANCE").className).toContain("warn");
  });
});

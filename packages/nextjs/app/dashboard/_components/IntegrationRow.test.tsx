import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HEALTH_SCENARIOS } from "@sh/sdk/testing";
import { IntegrationRow } from "./IntegrationRow";

describe("IntegrationRow", () => {
  it("shows a healthy integration without remediation, with its HashScan link opening safely", async () => {
    const { report } = await HEALTH_SCENARIOS.healthy();
    render(<IntegrationRow item={report.integrations.hcs} />);

    const row = screen.getByRole("article", { name: "HCS evidence topic" });
    expect(within(row).getByRole("status").textContent).toBe("OK");
    expect(within(row).queryByText("Fix:")).toBeNull();
    const link = within(row).getByRole("link");
    expect(link.getAttribute("href")).toMatch(/^https:\/\/hashscan\.io\/testnet\//);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  it("explains a configuration error and names the variable to fix", async () => {
    const { report } = await HEALTH_SCENARIOS.registryMissing();
    const item = report.integrations.registry;
    render(<IntegrationRow item={item} />);

    expect(screen.getByRole("status").textContent).toBe("Error");
    expect(screen.getByText("Fix:")).toBeTruthy();
    expect(screen.getByText(item.remediation!, { exact: false })).toBeTruthy();
    expect(screen.getByText(item.variable!).tagName).toBe("CODE");
  });

  it("marks a connectivity failure as transient instead of a wrong configuration", async () => {
    const { report } = await HEALTH_SCENARIOS.mirrorDown();
    render(<IntegrationRow item={report.integrations.mirror} />);

    expect(screen.getByRole("status").textContent).toBe("Unreachable");
    expect(screen.getByText(/Connectivity only/)).toBeTruthy();
  });

  it("asks to configure what is not configured yet", async () => {
    const { report } = await HEALTH_SCENARIOS.unconfigured();
    const item = report.integrations.registry;
    render(<IntegrationRow item={item} />);

    expect(screen.getByRole("status").textContent).toBe("Not configured");
    expect(screen.getByText(item.summary)).toBeTruthy();
  });

  it("lists warnings", () => {
    render(
      <IntegrationRow
        item={{
          id: "mirror",
          label: "Mirror Node",
          status: "ok",
          summary: "Reachable.",
          warnings: ["Indexing lag is 125 s."],
          links: [],
          details: {},
        }}
      />,
    );
    expect(screen.getByRole("listitem").textContent).toBe("Indexing lag is 125 s.");
  });
});

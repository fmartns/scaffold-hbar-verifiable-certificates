import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentVariables } from "@sh/sdk";
import type { FakeNetworkOptions } from "@sh/sdk/testing";
import {
  HBAR,
  HEALTH_ACCOUNT,
  HEALTH_REGISTRY,
  HEALTH_TOPIC,
  fakeHederaNetwork,
  healthEnv,
  healthEnvWithoutKey as envWithoutKey,
  healthNow,
} from "@sh/sdk/testing";
import Loading from "./loading";
import DashboardPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const HEALTH_VARIABLES = Object.keys(healthEnv);

/** The page runs the real `checkHederaHealth(process.env)`: point the environment and `fetch` at the fake network. */
async function renderDashboard(env: EnvironmentVariables, network: FakeNetworkOptions = {}) {
  for (const name of HEALTH_VARIABLES) vi.stubEnv(name, env[name] ?? "");
  vi.stubGlobal("fetch", fakeHederaNetwork(network).fetch);
  vi.useFakeTimers({ now: healthNow(), toFake: ["Date"] });
  return render(await DashboardPage());
}

beforeEach(() => {
  delete window.ethereum;
});

describe("DashboardPage", () => {
  it("renders a healthy environment with every integration, the deployment and no validation issues", async () => {
    await renderDashboard(envWithoutKey);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hedera environment");
    expect(screen.getByText(/Every integration is healthy\./)).toBeTruthy();
    expect(screen.getByText(/18\/09\/2026, 12:00:00 UTC/)).toBeTruthy();

    const operator = screen.getByRole("region", { name: /Operator account/ });
    expect(within(operator).getByText(HEALTH_ACCOUNT)).toBeTruthy();
    expect(within(operator).getByText(/100 HBAR/)).toBeTruthy();
    expect(within(operator).getByRole("link", { name: /Testnet faucet/ })).toBeTruthy();

    const deployment = screen.getByRole("region", { name: "Deployment" });
    expect(within(deployment).getByText(HEALTH_REGISTRY)).toBeTruthy();
    expect(within(deployment).getAllByText(HEALTH_TOPIC).length).toBeGreaterThan(0);
    expect(within(deployment).getByText("https://testnet.mirrornode.hedera.com")).toBeTruthy();

    const integrations = screen.getByRole("region", { name: "Integrations" });
    expect(within(integrations).getAllByRole("article")).toHaveLength(5);
    expect(screen.queryByRole("region", { name: "Environment validation" })).toBeNull();
  });

  it("asks to finish the configuration when only the network is set", async () => {
    await renderDashboard({ HEDERA_NETWORK: "testnet" });

    expect(screen.getByText(/some integrations are not configured yet/)).toBeTruthy();
    const operator = screen.getByRole("region", { name: /Operator account/ });
    expect(within(operator).getByText("not set")).toBeTruthy();
    expect(within(operator).getByText("unknown")).toBeTruthy();
  });

  it("lists validation issues with their remediation when the balance is too low", async () => {
    await renderDashboard(envWithoutKey, { balance: 3n * HBAR });

    expect(screen.getByText(/At least one integration needs attention\./)).toBeTruthy();
    const issues = screen.getByRole("region", { name: "Environment validation" });
    expect(within(issues).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(issues).getAllByText("Fix:").length).toBeGreaterThan(0);
  });

  it("shows unreachable infrastructure as transient errors", async () => {
    await renderDashboard(envWithoutKey, { mirror: "down", relayChainId: "down" });

    const integrations = screen.getByRole("region", { name: "Integrations" });
    expect(within(integrations).getAllByText("Unreachable").length).toBeGreaterThan(0);
    expect(within(integrations).getAllByText(/Connectivity only/).length).toBeGreaterThan(0);
  });

  it("explains an unsupported network instead of crashing", async () => {
    await renderDashboard({ ...envWithoutKey, HEDERA_NETWORK: "devnet" });

    expect(screen.getByText("invalid HEDERA_NETWORK")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Environment validation" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Testnet faucet/ })).toBeNull();
  });

  it("never renders the operator key", async () => {
    const { container } = await renderDashboard(healthEnv);
    expect(container.innerHTML).not.toContain(healthEnv.HEDERA_OPERATOR_KEY);
  });
});

describe("Dashboard loading state", () => {
  it("announces that the checks are running", () => {
    render(<Loading />);
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText(/Checking the network/)).toBeTruthy();
  });
});

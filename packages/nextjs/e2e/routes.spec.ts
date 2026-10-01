import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for every top-level route in the developer console: each one must render its primary heading
 * with no unconfigured Hedera environment required (`/`, `/dashboard` and `/issuer` all degrade to a
 * "not configured" state rather than throwing — see `packages/sdk/hedera/health.ts`). This is deliberately not a
 * behavior test; `routes.spec.ts` only guards against a route failing to render at all (a broken import, a server
 * component throwing, a client bundle failing to hydrate).
 */

test.describe("top-level routes render", () => {
  test("home page shows the target network summary", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Verifiable Settlement" })).toBeVisible();
    await expect(page.getByText("Target network")).toBeVisible();
    await expect(page.getByRole("link", { name: /Check the environment health/ })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });

  test("dashboard renders environment health without a configured Hedera network", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 2, name: "Operator account" })).toBeVisible();
  });

  test("issuer console renders its header", async ({ page }) => {
    await page.goto("/issuer");
    await expect(page.getByRole("heading", { name: "Issuer console" })).toBeVisible();
  });

  test("verify entry page renders its header and form", async ({ page }) => {
    await page.goto("/verify");
    await expect(page.getByRole("heading", { name: "Verify a credential" })).toBeVisible();
    await expect(page.getByLabel("Credential id")).toBeVisible();
  });

  test("an unknown route 404s", async ({ page }) => {
    const response = await page.goto("/this-route-does-not-exist");
    expect(response?.status()).toBe(404);
  });
});

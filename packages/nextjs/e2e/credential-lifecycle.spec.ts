import {
  CREDENTIAL_ID,
  REVOKED_CREDENTIAL_ID,
  UNKNOWN_CREDENTIAL_ID,
  expect,
  mockCredentialApi,
  test,
} from "./fixtures";

/**
 * The public verifier's read lifecycle (issue #15), driven through the real browser UI: landing on `/verify`,
 * typing a credential id, following through to `/verify/<id>`, and reading the four core questions `StatusCard`
 * answers from `CredentialRegistry.statusOf` (ADR §4.3 — `statusOf` is the authority; this test never asserts
 * anything the component itself does not render). The console API routes are mocked at the HTTP boundary
 * (`mockCredentialApi`, see `./fixtures.ts`) so the suite needs no live Hedera network or credentials — issuing a
 * real credential end to end (wallet signature, HCS publish, on-chain settlement) is out of scope here and belongs
 * with the testnet validation track (`yarn verify:testnet`, issue #18), not a browser smoke suite.
 */

test.describe("credential verification lifecycle", () => {
  test("an issued credential: entry form navigates to the result and shows it as active", async ({ page }) => {
    await mockCredentialApi(page, CREDENTIAL_ID, "issued");

    await page.goto("/verify");
    await page.getByLabel("Credential id").fill(CREDENTIAL_ID);
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page).toHaveURL(`/verify/${CREDENTIAL_ID}`);
    await expect(page.getByText("Active")).toBeVisible();
    await expect(page.getByText("Yes — it is recorded on CredentialRegistry.")).toBeVisible();
    await expect(page.getByText("Valid — it has not been revoked.")).toBeVisible();
    await expect(page.getByText(ISSUER_TEXT)).toBeVisible();

    // The evidence trail and the local integrity check only render for a resolvable id.
    await expect(page.getByRole("heading", { name: "Was the document altered?" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Share this check" })).toBeVisible();
  });

  test("a revoked credential is shown as revoked, not merely 'inactive'", async ({ page }) => {
    await mockCredentialApi(page, REVOKED_CREDENTIAL_ID, "revoked");

    await page.goto(`/verify/${REVOKED_CREDENTIAL_ID}`);

    await expect(page.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(page.getByText(/Revoked on/)).toBeVisible();
  });

  test("a credential id with no on-chain record is reported as not found, never as an error", async ({ page }) => {
    await mockCredentialApi(page, UNKNOWN_CREDENTIAL_ID, "not_found");

    await page.goto(`/verify/${UNKNOWN_CREDENTIAL_ID}`);

    await expect(page.getByText("Not found", { exact: true })).toBeVisible();
    await expect(page.getByText(/No record of this credential id exists/)).toBeVisible();
  });

  test("typing something that is not a credential id is rejected before any request is made", async ({ page }) => {
    let called = false;
    await page.route("**/api/credentials/status*", async route => {
      called = true;
      await route.abort();
    });

    await page.goto("/verify");
    await page.getByLabel("Credential id").fill("not-a-credential-id");
    await page.getByRole("button", { name: "Verify" }).click();

    // Next.js also renders its own `role="alert"` route announcer, so scope to the visible message text instead
    // of relying on role alone.
    await expect(page.getByText("That does not look like a credential id")).toBeVisible();
    await expect(page).toHaveURL(/\/verify$/);
    expect(called).toBe(false);
  });
});

const ISSUER_TEXT = `0x${"aa".repeat(32)}`;

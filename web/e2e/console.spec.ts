import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { totp } from "./totp";

const setupToken = process.env.AUZ_SETUP_TOKEN ?? "";
const agentBin = process.env.AUZ_AGENT_BIN ?? "";
const gateway = process.env.AUZ_GATEWAY ?? "127.0.0.1:18443";
const shots = process.env.AUZ_SCREENSHOTS ?? "";
const email = "admin@example.com";
const password = "Granite-Lantern-Pickle-42";

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

async function typeCode(page: Page, code: string) {
  await page.getByLabel("Authenticator code").fill(code);
}

test("first-run setup, MFA login, enrollment, live device, revoke, audit", async ({ page }) => {
  expect(setupToken, "AUZ_SETUP_TOKEN must be set").not.toBe("");
  // Record every CSP violation; the console must run under the strict policy.
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Refused \(CSP\)/.test(m.text())) violations.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      console.error(`Refused (CSP): ${e.violatedDirective} ${e.blockedURI} sample=${e.sample} src=${e.sourceFile}:${e.lineNumber} url=${location.pathname}`);
    });
  });

  // --- Setup wizard ---
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByLabel(/^Setup token/).fill(setupToken);
  await page.getByLabel(/^Administrator email/).fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByAltText("Authenticator QR code")).toBeVisible();
  const secret = (await page.locator("pre").first().innerText()).trim();
  await page.getByLabel(/^Organization name/).fill("Acme Corp");
  await page.getByLabel(/^Your name/).fill("Ada Admin");
  // Mantine's required asterisk is part of the accessible name; address fields by order.
  const pw = page.locator('input[type="password"]');
  await expect(pw).toHaveCount(4);
  await pw.nth(0).fill(password);
  await pw.nth(1).fill(password);
  await pw.nth(2).fill("correct horse battery staple root");
  await pw.nth(3).fill("correct horse battery staple root");
  await shot(page, "01-setup");
  await typeCode(page, totp(secret, 0));
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByText("Store these recovery codes")).toBeVisible();
  await shot(page, "02-recovery-codes");
  await page.getByLabel("I have saved my recovery codes").check();
  await page.getByRole("button", { name: "Continue to sign in" }).click();

  // --- Login with MFA (next time step: the setup step was consumed) ---
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel(/^Email/).fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await typeCode(page, totp(secret, 1));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();
  await expect(page.getByText("No devices yet")).toBeVisible();

  // --- Enrollment token ---
  await page.getByRole("link", { name: "Enrollment" }).click();
  await page.getByRole("button", { name: "New token" }).click();
  await page.getByLabel(/^Name/).fill("GUI test");
  await page.getByRole("button", { name: "Create" }).click();
  const cmd = (await page.locator("pre").first().innerText()).trim();
  expect(cmd).toContain("auzring-agent.exe install --server");
  await shot(page, "03-token");
  const enrollment = cmd.split("--token ")[1]!.trim();
  await page.keyboard.press("Escape");

  // --- Start a real agent; the device must appear live (SSE) ---
  let agent: ChildProcess | undefined;
  if (agentBin) {
    const dir = mkdtempSync(join(tmpdir(), "auz-agent-"));
    agent = spawn(agentBin, ["run", "--data-dir", dir, "--server", gateway, "--token", enrollment], { stdio: "ignore" });
  }
  try {
    await page.getByRole("link", { name: "Devices" }).click();
    if (agentBin) {
      const row = page.getByTestId("device-row").first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByText("online")).toBeVisible({ timeout: 30_000 });
      await shot(page, "04-devices");
      await row.click();
      await expect(page.getByText("Hardware")).toBeVisible();
      await expect(page.getByText("Client certificates")).toBeVisible();
      await page.waitForTimeout(500); // let the drawer finish animating
      await shot(page, "05-device-detail");
      await page.getByRole("button", { name: "Revoke" }).click();
      await page.getByLabel("Reason (recorded in the audit log)").fill("GUI test");
      await page.getByRole("button", { name: "Revoke device" }).click();
      await expect(page.getByText("Revoked: GUI test")).toBeVisible({ timeout: 15_000 });
      await page.keyboard.press("Escape");
    }
  } finally {
    agent?.kill();
  }

  // --- Audit log ---
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByRole("cell", { name: "setup.complete" })).toBeVisible();
  if (agentBin) await expect(page.getByRole("cell", { name: "device.revoke" })).toBeVisible();
  await shot(page, "06-audit");

  // --- Sign out ---
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  expect(violations, "CSP violations").toEqual([]);
});

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
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
  const agentDirs: string[] = [];
  if (agentBin) {
    const dir = mkdtempSync(join(tmpdir(), "auz-agent-"));
    agentDirs.push(dir);
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
      await expect(page).toHaveURL(/\/devices\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("tab", { name: "Hardware" })).toBeVisible();
      await page.getByRole("tab", { name: "Hardware" }).click();
      await expect(page.getByText("Memory")).toBeVisible();
      await shot(page, "05-device-hardware");

      // Software inventory: the dev agent on Linux reports dpkg packages.
      await page.getByRole("tab", { name: /^Software/ }).click();
      await expect(page.getByTestId("software-row").first()).toBeVisible({ timeout: 30_000 });
      await shot(page, "05-device-software");
      await page.getByLabel("Filter software").fill("zzz-no-such-package");
      await expect(page.getByText("No software reported yet.")).toBeVisible();
      await page.getByLabel("Filter software").fill("");
      await page.getByRole("tab", { name: "Users" }).click();
      await page.getByRole("tab", { name: "Client certificates" }).click();
      await expect(page.getByRole("table", { name: "Certificates" })).toBeVisible();

      // Fleet-wide software search.
      await page.getByRole("link", { name: "Software" }).click();
      await expect(page.getByRole("heading", { name: "Software" })).toBeVisible();
      await expect(page.getByTestId("title-row").first()).toBeVisible({ timeout: 15_000 });
      await page.getByLabel("Search software").fill("lib");
      await expect(page.getByTestId("title-row").first()).toBeVisible();
      await page.getByTestId("title-row").first().click();
      await expect(page.getByRole("table", { name: "Devices with this software" })).toBeVisible();
      await shot(page, "07-software");
      await page.keyboard.press("Escape");
      const download = page.waitForEvent("download");
      await page.getByRole("link", { name: "Export CSV" }).first().click();
      expect((await download).suggestedFilename()).toMatch(/^auzring-software-.*\.csv$/);

      // Dynamic group: preview, save, list.
      await page.getByRole("link", { name: "Groups" }).click();
      await page.getByRole("button", { name: "New group" }).click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Has lib packages");
      await page.getByLabel("Product name").fill("lib");
      await page.getByRole("button", { name: "Preview matches" }).click();
      await expect(page.getByTestId("preview-total")).toHaveText("1 matching device");
      await shot(page, "08-group-editor");
      await page.getByRole("button", { name: "Save group" }).click();
      await expect(page.getByTestId("group-row")).toHaveCount(1);
      await page.getByRole("button", { name: "Has lib packages" }).click();
      await expect(page.getByText("1 device")).toBeVisible();
      await page.keyboard.press("Escape");

      // Custom package -> deployment -> live job result (the Linux dev agent runs the uploaded script).
      const agentDir = agentDirs[0]!;
      await page.getByRole("link", { name: "Catalog" }).click();
      await page.getByRole("button", { name: "Upload custom installer" }).click();
      const script = '#!/bin/sh\nmkdir -p "$(dirname "$0")/../../pf/Acme"\necho ok > "$(dirname "$0")/../../pf/Acme/tool.txt"\nexit 0\n';
      await page.getByLabel("Installer file").setInputFiles({ name: "install.sh", mimeType: "application/octet-stream", buffer: Buffer.from(script) });
      await page.getByLabel(/^Identifier/).fill("Acme.Tool");
      await page.getByRole("textbox", { name: /^Name/ }).fill("Acme Tool");
      await page.getByLabel(/^Version/).first().fill("1.0.0");
      await page.getByRole("combobox", { name: "Installer type" }).click();
      await page.getByRole("option", { name: "exe", exact: true }).click();
      await page.getByRole("combobox", { name: "Architecture" }).click();
      await page.getByRole("option", { name: "neutral" }).click();
      await page.getByLabel("Silent arguments").fill("/silent");
      await page.getByLabel("Detection file path").fill("%ProgramFiles%/Acme/tool.txt");
      await shot(page, "09-custom-upload");
      await page.getByRole("button", { name: "Upload and add" }).click();
      await expect(page.getByRole("heading", { name: "Acme Tool" })).toBeVisible();
      await shot(page, "10-package");
      await page.getByRole("link", { name: "Deploy", exact: true }).click();
      await page.getByRole("combobox", { name: "Devices" }).click();
      await page.getByRole("option").first().click();
      await page.keyboard.press("Escape");
      await shot(page, "11-deployment-new");
      await page.getByRole("button", { name: "Start deployment" }).click();
      await expect(page.getByText("Deployment queued")).toBeVisible();
      await page.getByRole("button", { name: "Watch progress" }).click();
      await expect(page.getByTestId("deployment-status")).toHaveText("completed", { timeout: 60_000 });
      await expect(page.getByTestId("job-row").getByText("succeeded")).toBeVisible();
      await shot(page, "12-deployment");
      await page.getByRole("button", { name: "Details" }).click();
      await expect(page.getByText("Timeline")).toBeVisible();
      await shot(page, "13-job-detail");
      await page.keyboard.press("Escape");
      expect(existsSync(join(agentDir, "pf", "Acme", "tool.txt"))).toBe(true);

      // Static group.
      await page.getByRole("link", { name: "Groups" }).click();
      await page.getByRole("button", { name: "New group" }).click();
      await page.getByText("Static (hand-picked)").click();
      await page.getByRole("textbox", { name: "Name", exact: true }).fill("Pilot ring");
      await page.getByRole("button", { name: "Save group" }).click();
      await page.getByRole("button", { name: "Pilot ring" }).click();
      await page.getByRole("combobox", { name: "Add devices" }).click();
      await page.getByRole("option").first().click();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByText("1 device")).toBeVisible();
      await page.keyboard.press("Escape");

      // Settings (admin).
      await page.getByRole("link", { name: "Settings" }).click();
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

      // Back to the device: refresh, missing updates, uninstall from the inventory, then revoke and delete.
      await page.getByRole("link", { name: "Devices" }).click();
      await page.getByTestId("device-row").first().click();
      await shot(page, "05-device-detail");
      await page.getByRole("button", { name: /Refresh/ }).click();
      await expect(page.getByText("Device information refreshed.")).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: "Missing updates" }).click();
      await expect(page.getByText(/No missing updates/)).toBeVisible();
      await page.getByRole("tab", { name: /^Software/ }).click();
      await expect(page.getByTestId("software-row").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Uninstall Software" })).toBeDisabled();
      await page.getByTestId("software-row").first().getByRole("checkbox").check();
      await expect(page.getByText("1 item selected")).toBeVisible();
      await shot(page, "14-device-software-selected");
      await page.getByRole("button", { name: "Uninstall Software" }).click();
      await expect(page.getByRole("table", { name: "Programs to uninstall" })).toBeVisible();
      await page.getByRole("dialog").getByRole("button", { name: "Uninstall" }).click();
      await expect(page.getByText(/Uninstall queued for 1 program/)).toBeVisible();
      await page.getByRole("tab", { name: "Jobs" }).click();
      await expect(page.getByRole("table", { name: "Device jobs" }).getByText(/^Uninstall /).first()).toBeVisible({ timeout: 15_000 });
      await page.getByRole("button", { name: "Revoke" }).click();
      await page.getByLabel("Reason (recorded in the audit log)").fill("GUI test");
      await page.getByRole("button", { name: "Revoke device" }).click();
      await expect(page.getByText("Revoked: GUI test")).toBeVisible({ timeout: 15_000 });
      // A revoked device can be deleted; an active one cannot (no button).
      await page.getByRole("button", { name: "Delete device" }).click();
      await page.getByRole("button", { name: "Delete permanently" }).click();
      await expect(page).toHaveURL(/localhost:\d+\/$/);
      await page.getByText("Revoked", { exact: true }).click();
      await expect(page.getByText("No devices yet")).toBeVisible();
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

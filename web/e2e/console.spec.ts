import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, request, test, type Page } from "@playwright/test";
import { totp } from "./totp";

const setupToken = process.env.AUZ_SETUP_TOKEN ?? "";
const agentBin = process.env.AUZ_AGENT_BIN ?? "";
const gateway = process.env.AUZ_GATEWAY ?? "127.0.0.1:18443";
const shots = process.env.AUZ_SCREENSHOTS ?? "";
// The license tool and a key whose public half the server trusts (scripts/gui-e2e.sh makes both for this run).
const licenseTool = process.env.AUZ_LICENSE_TOOL ?? "";
const licenseKey = process.env.AUZ_LICENSE_KEY ?? "";

/** Signs a demo license with the run's key; returns the pasteable AZL1 text. */
function signLicense(key: string, args: string[]): string {
  return execFileSync(licenseTool, ["sign", "--key", key, ...args], { encoding: "utf8" }).trim();
}
const ymd = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
const email = "admin@example.com";
const password = "Granite-Lantern-Pickle-42";

async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

async function typeCode(page: Page, code: string) {
  await page.getByLabel("Authenticator code").fill(code);
}

test("first-run setup, MFA login, enrollment, live device, revoke, audit", async ({ page, browser }) => {
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
  expect(cmd).toContain("renovatio-agent.exe install --server");
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
      await page.getByRole("link", { name: "Software", exact: true }).click();
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
      expect((await download).suggestedFilename()).toMatch(/^renovatio-software-.*\.csv$/);

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

      // Windows updates: the dev agent reads scripted updates from wu-dev.json in its data directory.
      const wuDir = agentDirs[0]!;
      const secID = "11111111-1111-4111-8111-111111111111";
      const drvID = "22222222-2222-4222-8222-222222222222";
      writeFileSync(
        join(wuDir, "wu-dev.json"),
        JSON.stringify({
          updates: [
            { id: secID, revision: 200, title: "2026-10 Cumulative Update for Windows 11 (KB5099999)", kb: ["5099999"], classification: "Security Updates", severity: "Critical", release_date: Math.floor(Date.now() / 1000) - 20 * 86400 },
            { id: drvID, revision: 1, title: "Acme Corp - Net - 1.2.3.4", classification: "Updates" },
          ],
        }),
      );
      await page.getByRole("link", { name: "Devices" }).click();
      await page.getByTestId("device-row").first().click();
      await page.getByRole("tab", { name: "Windows updates" }).click();
      await page.getByRole("button", { name: "Scan now" }).click();
      const devUpdates = page.getByRole("table", { name: "Windows updates on this device" });
      await expect(devUpdates.getByText("KB5099999", { exact: true })).toBeVisible({ timeout: 60_000 });
      await shot(page, "15-device-windows-updates");

      // Catalog: approve the security update, leave the other one pending.
      await page.getByRole("link", { name: "Windows updates" }).click();
      await expect(page.getByRole("heading", { name: "Windows updates" })).toBeVisible();
      const secRow = page.getByRole("row", { name: /KB5099999/ });
      await expect(secRow).toBeVisible({ timeout: 15_000 });
      await secRow.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(secRow.getByText("approved")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("row", { name: /Acme Corp/ }).getByText("pending")).toBeVisible();
      await shot(page, "16-updates-catalog");

      // Policy: a ring over the saved group, a rule, and the update source.
      await page.getByRole("link", { name: "Update policy" }).click();
      await expect(page.getByRole("heading", { name: "Update policy" })).toBeVisible();
      await page.getByRole("button", { name: "Add ring" }).click();
      await page.getByRole("dialog").getByLabel("Name").fill("Pilot");
      await page.getByRole("dialog").getByLabel("Groups").click();
      await page.getByRole("option", { name: "Has lib packages" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Save ring" }).click();
      await expect(page.getByRole("table", { name: "Update rings" }).getByText("Pilot")).toBeVisible({ timeout: 15_000 });
      await page.mouse.move(0, 0); // a hovered toast does not time out and would cover the next button
      await page.getByRole("button", { name: "Add rule" }).click();
      await page.getByRole("dialog").getByLabel("Name").fill("Critical security");
      await page.getByRole("dialog").getByLabel("Severities").click({ force: true });
      await page.getByRole("option", { name: "Critical" }).click();
      await page.getByRole("dialog").getByText("Add rule").click();
      await page.getByRole("dialog").getByRole("button", { name: "Save rule" }).click();
      await expect(page.getByRole("table", { name: "Auto-approval rules" }).getByText("Critical security")).toBeVisible({ timeout: 15_000 });
      await shot(page, "17-update-policy");

      // Install the other update by hand on the device; after a rescan it is no longer missing.
      await page.getByRole("link", { name: "Devices" }).click();
      await page.getByTestId("device-row").first().click();
      await page.getByRole("tab", { name: "Windows updates" }).click();
      await devUpdates.getByRole("row", { name: /Acme Corp/ }).getByRole("checkbox").check();
      await page.getByRole("button", { name: "Install selected" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Install", exact: true }).click();
      await expect(page.getByText("Install queued.")).toBeVisible();
      await expect(async () => {
        await page.getByRole("button", { name: "Scan now" }).click();
        await expect(devUpdates.getByText("Acme Corp")).toHaveCount(0, { timeout: 15_000 });
      }).toPass({ timeout: 90_000 });

      // On the device page already: refresh, missing updates, uninstall from the inventory, then revoke and delete.
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

  // --- Identity: a site, a site-limited technician, a security key and an API token ---
  const origin = new URL(page.url()).origin;
  await page.getByRole("link", { name: "Sites" }).click();
  await page.getByRole("button", { name: "Add site" }).click();
  await page.getByRole("dialog").getByLabel(/^Name/).fill("Branch office");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("table", { name: "Sites" }).getByText("Branch office")).toBeVisible();
  await shot(page, "18-sites");

  await page.getByRole("link", { name: "Users" }).click();
  await page.getByRole("button", { name: "Add user" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel(/^Email/).fill("tech@example.com");
  await dlg.getByLabel(/^Name/).fill("Tess Tech");
  await dlg.getByLabel("Applies to").click();
  await page.getByRole("option", { name: "Site: Branch office" }).click();
  await dlg.getByRole("button", { name: "Create user" }).click();
  const temp = (await page.getByRole("dialog").locator("pre").first().innerText()).trim();
  expect(temp.length).toBeGreaterThanOrEqual(16);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("user-row").filter({ hasText: "tech@example.com" })).toContainText("site Branch office");
  await shot(page, "19-users");

  // The technician: forced password change, authenticator enrollment, and a console limited to devices.
  const techCtx = await browser.newContext({ baseURL: origin });
  const tp = await techCtx.newPage();
  await tp.goto("/login");
  await tp.getByLabel(/^Email/).fill("tech@example.com");
  await tp.locator('input[type="password"]').fill(temp);
  await tp.getByRole("button", { name: "Continue" }).click();
  await expect(tp.getByText("temporary password")).toBeVisible();
  await tp.getByLabel(/^New password/).fill("Quartz-Harbor-Violin-77");
  await tp.getByLabel(/^Repeat the new password/).fill("Quartz-Harbor-Violin-77");
  await tp.getByRole("button", { name: "Change password" }).click();
  await expect(tp.getByAltText("Authenticator QR code")).toBeVisible();
  const techSecret = (await tp.locator("pre").first().innerText()).trim();
  await typeCode(tp, totp(techSecret, 0));
  await tp.getByRole("button", { name: "Confirm" }).click();
  await tp.getByRole("button", { name: "I have saved them, continue" }).click();
  await expect(tp.getByRole("heading", { name: "Devices" })).toBeVisible();
  for (const hidden of ["Software", "Groups", "Catalog", "Deployments", "Users", "Audit log", "Settings"]) {
    await expect(tp.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
  }
  await shot(tp, "20-site-limited-console");
  await techCtx.close();

  // A security key (software authenticator through the browser's WebAuthn test API) and an API token.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "usb", hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.getByRole("link", { name: "Ada Admin" }).click();
  await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
  await page.getByLabel("Name for a new key").fill("Test key");
  await page.getByRole("button", { name: "Add security key" }).click();
  await expect(page.getByRole("table", { name: "Security keys" }).getByText("Test key")).toBeVisible();
  await page.getByLabel("Token name").fill("CI sync");
  await page.getByLabel("devices:read").check();
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByText("Copy the token now")).toBeVisible();
  const apiToken = (await page.getByRole("alert").locator("pre").first().innerText()).trim();
  expect(apiToken).toMatch(/^azt_/);
  await shot(page, "21-account-security");
  const bare = await request.newContext({ baseURL: origin });
  expect((await bare.get("/api/v1/devices", { headers: { Authorization: `Bearer ${apiToken}` } })).status()).toBe(200);
  expect((await bare.get("/api/v1/audit", { headers: { Authorization: `Bearer ${apiToken}` } })).status()).toBe(403);
  await bare.dispose();

  // Sign out and back in with the security key instead of an authenticator code.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel(/^Email/).fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Use a security key" }).click();
  await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible();

  // --- Automation: a software policy, the reports page, and the audit chain check ---
  await page.getByRole("link", { name: "Software policies" }).click();
  await page.getByRole("button", { name: "Add policy" }).click();
  const pd = page.getByRole("dialog");
  await pd.getByLabel(/^Name/).fill("Keep Acme Tool current");
  await pd.getByLabel(/^Package/).click();
  await page.getByRole("option", { name: "Acme Tool" }).click();
  await pd.getByLabel(/^Groups/).click();
  await page.getByRole("option").first().click();
  await pd.getByText("Add policy").click(); // close the dropdown
  await pd.getByRole("button", { name: "Save policy" }).click();
  await expect(page.getByRole("table", { name: "Software policies" }).getByText("Keep Acme Tool current")).toBeVisible();
  await shot(page, "22-policies");

  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByText("Patch compliant")).toBeVisible();
  await shot(page, "23-reports");

  // --- License: unlicensed evaluation, a forged license is refused, a real one is installed, expiry warning ---
  if (licenseTool && licenseKey) {
    await page.getByRole("link", { name: "License", exact: true }).click();
    await expect(page.getByRole("heading", { name: "License", exact: true })).toBeVisible();
    await expect(page.getByTestId("license-state")).toHaveText("Unlicensed (evaluation)");
    await expect(page.getByTestId("license-usage")).toContainText("of 25 devices enrolled");
    await shot(page, "24-license-unlicensed");

    // A license signed by some other key is refused with a clear message.
    const otherDir = mkdtempSync(join(tmpdir(), "auz-lic-"));
    execFileSync(licenseTool, ["keygen", "--out", join(otherDir, "other.key")], { stdio: "ignore" });
    const forged = signLicense(join(otherDir, "other.key"), ["--licensee", "Mallory", "--max-devices", "100000"]);
    await page.getByTestId("license-input").fill(forged);
    await page.getByTestId("license-install").click();
    await expect(page.getByText(/does not verify under a trusted vendor license key/)).toBeVisible();
    await expect(page.getByTestId("license-state")).toHaveText("Unlicensed (evaluation)");
    await page.mouse.move(0, 0); // a hovered toast does not time out

    // The real license (signed by this run's key) is installed and takes effect at once.
    const lic1 = signLicense(licenseKey, ["--licensee", "GUI Test Ltd", "--max-devices", "50", "--features", "reports.export", "--expires", ymd(365), "--updates-until", ymd(365)]);
    await page.getByTestId("license-input").fill(lic1);
    await page.getByTestId("license-install").click();
    await expect(page.getByText(/License installed/)).toBeVisible();
    await expect(page.getByTestId("license-state")).toHaveText("Licensed");
    await expect(page.getByTestId("license-usage")).toContainText("of 50 devices enrolled");
    await expect(page.getByTestId("license-licensee")).toHaveText("GUI Test Ltd");
    await expect(page.getByTestId("license-input")).toHaveValue("");
    await shot(page, "25-license-installed");
    await page.mouse.move(0, 0);

    // A renewal that ends within 30 days makes the Devices page warn.
    const lic2 = signLicense(licenseKey, ["--licensee", "GUI Test Ltd", "--max-devices", "50", "--expires", ymd(10)]);
    await page.getByTestId("license-input").fill(lic2);
    await page.getByTestId("license-install").click();
    await expect(page.getByRole("table", { name: "License history" }).getByRole("row")).toHaveCount(3, { timeout: 15_000 }); // header + 2
    await page.getByRole("link", { name: "Devices", exact: true }).click();
    await expect(page.getByTestId("license-banner")).toContainText("The license expires soon");
    await shot(page, "26-license-banner");
  }

  // --- Audit log ---
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByRole("cell", { name: "setup.complete" })).toBeVisible();
  if (licenseTool && licenseKey) {
    await expect(page.getByRole("cell", { name: "license.install" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "license.invalid" }).first()).toBeVisible();
  }
  if (agentBin) await expect(page.getByRole("cell", { name: "device.revoke" })).toBeVisible();
  await page.getByRole("button", { name: "Verify the chain" }).click();
  await expect(page.getByText(/The chain is intact/)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel("Action starts with").fill("user.");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page.getByRole("cell", { name: "user.create" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "setup.complete" })).toHaveCount(0);
  await shot(page, "06-audit");

  // --- Sign out ---
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  expect(violations, "CSP violations").toEqual([]);
});

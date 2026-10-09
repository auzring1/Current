/** The tabs of the device page, in display order. */
export const DEVICE_TABS = ["overview", "hardware", "software", "updates", "jobs", "activity"] as const;
export type DeviceTab = (typeof DEVICE_TABS)[number];

/**
 * Old and alternative `?tab=` values and the tab that now holds their content.
 * "Missing updates" and "Windows updates" were merged, "Users" moved into Overview and
 * "Client certificates" into Hardware.
 */
export const DEVICE_TAB_ALIASES: Readonly<Record<string, DeviceTab>> = {
  missing: "updates",
  "missing-updates": "updates",
  missing_updates: "updates",
  "windows-updates": "updates",
  windows_updates: "updates",
  windowsupdates: "updates",
  winupdates: "updates",
  wu: "updates",
  users: "overview",
  certificates: "hardware",
  certs: "hardware",
  "client-certificates": "hardware",
};

/** Which optional tabs the person may see. Overview, Hardware and Software are always available. */
export interface DeviceTabAccess {
  /** `deployments:read` or `updates:read`: either one shows the merged Windows updates tab (each section keeps its own gate). */
  hasUpdates: boolean;
  /** `deployments:read` */
  hasJobs: boolean;
  /** `audit:read` on the organization */
  hasActivity: boolean;
}

export function availableDeviceTabs(access: DeviceTabAccess): DeviceTab[] {
  return DEVICE_TABS.filter((t) => (t === "updates" ? access.hasUpdates : t === "jobs" ? access.hasJobs : t === "activity" ? access.hasActivity : true));
}

/**
 * Turns whatever is in `?tab=` into the tab to show: old names are mapped through the alias table,
 * and anything unknown or not permitted falls back to Overview.
 */
export function resolveDeviceTab(raw: string | null | undefined, access: DeviceTabAccess): DeviceTab {
  const key = (raw ?? "").trim().toLowerCase();
  const tab = (DEVICE_TABS as readonly string[]).includes(key)
    ? (key as DeviceTab)
    : Object.prototype.hasOwnProperty.call(DEVICE_TAB_ALIASES, key)
      ? DEVICE_TAB_ALIASES[key]
      : undefined;
  return tab && availableDeviceTabs(access).includes(tab) ? tab : "overview";
}

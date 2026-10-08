import type { components } from "./schema";

export type LicenseStatus = components["schemas"]["LicenseStatus"];
export type LicenseHistoryItem = components["schemas"]["LicenseHistoryItem"];

const DAY = 86_400_000;
/** Warn this long before a subscription ends. */
export const EXPIRY_WARNING_DAYS = 30;

export interface LicenseBannerInfo {
  color: "red" | "orange" | "yellow";
  title: string;
  text: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * What the Devices page should tell an administrator about licensing, or null when all is well.
 * A license problem only ever blocks NEW enrollments and approvals, and the text says so.
 */
export function licenseBanner(s: LicenseStatus | undefined, now = Date.now()): LicenseBannerInfo | null {
  if (!s) return null;
  if (s.state === "invalid") {
    return { color: "red", title: "The installed license cannot be used", text: `${s.message} The evaluation limit of ${s.max_devices} devices applies; existing devices keep working.` };
  }
  if (s.state === "grace" && s.grace_ends_at) {
    return {
      color: "red",
      title: "The license subscription has ended",
      text: `Renew it before ${day(s.grace_ends_at)}; after that the evaluation limit of ${s.evaluation_max_devices} devices applies to new enrollments. Existing devices keep working.`,
    };
  }
  if (s.at_capacity) {
    return {
      color: "orange",
      title: s.over_capacity ? "More devices than the license covers" : "Device limit reached",
      text: `${s.devices} of ${s.max_devices} devices are enrolled. New enrollments and approvals are blocked until a license with more devices is installed; devices that are already enrolled keep working.`,
    };
  }
  const exp = s.license?.expires_at;
  if (s.state === "licensed" && exp) {
    const left = new Date(exp).getTime() - now;
    if (left < EXPIRY_WARNING_DAYS * DAY) {
      return { color: "yellow", title: "The license expires soon", text: `The subscription ends on ${day(exp)}. Install the renewed license before then.` };
    }
  }
  return null;
}

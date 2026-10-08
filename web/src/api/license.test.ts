import { describe, expect, it } from "vitest";
import { licenseBanner, type LicenseStatus } from "./license";

const now = Date.parse("2026-10-08T12:00:00Z");
const base: LicenseStatus = {
  state: "licensed",
  message: "",
  configured: true,
  max_devices: 100,
  devices: 10,
  pending_devices: 0,
  at_capacity: false,
  over_capacity: false,
  grace_ends_at: null,
  evaluation_max_devices: 25,
  features: [],
  license: null,
  now: "2026-10-08T12:00:00Z",
};
const lic = (expires: string | null) => ({
  license_id: "L",
  licensee: "A",
  issued_at: "2026-01-01T00:00:00Z",
  not_before: "2026-01-01T00:00:00Z",
  expires_at: expires,
  max_devices: 100,
  features: [],
  updates_until: null,
  notes: "",
  key_id: "k",
  installed_at: "2026-01-01T00:00:00Z",
});

describe("licenseBanner", () => {
  it("is quiet when all is well, or unknown", () => {
    expect(licenseBanner(undefined, now)).toBeNull();
    expect(licenseBanner(base, now)).toBeNull();
    expect(licenseBanner({ ...base, license: lic("2027-10-08T00:00:00Z") }, now)).toBeNull();
    expect(licenseBanner({ ...base, state: "evaluation", max_devices: 25, devices: 3 }, now)).toBeNull();
  });
  it("warns at the cap and says existing devices keep working", () => {
    const b = licenseBanner({ ...base, state: "evaluation", max_devices: 25, devices: 25, at_capacity: true }, now);
    expect(b?.color).toBe("orange");
    expect(b?.title).toBe("Device limit reached");
    expect(b?.text).toContain("25 of 25");
    expect(b?.text).toContain("keep working");
  });
  it("distinguishes over the cap", () => {
    const b = licenseBanner({ ...base, max_devices: 5, devices: 9, at_capacity: true, over_capacity: true }, now);
    expect(b?.title).toBe("More devices than the license covers");
  });
  it("warns within 30 days of expiry only", () => {
    expect(licenseBanner({ ...base, license: lic("2026-11-01T00:00:00Z") }, now)?.color).toBe("yellow");
    expect(licenseBanner({ ...base, license: lic("2026-11-20T00:00:00Z") }, now)).toBeNull();
  });
  it("is red during grace and for an invalid license", () => {
    expect(licenseBanner({ ...base, state: "grace", grace_ends_at: "2026-11-01T00:00:00Z", license: lic("2026-10-01T00:00:00Z") }, now)?.color).toBe("red");
    expect(licenseBanner({ ...base, state: "invalid", max_devices: 25, message: "Not valid yet." }, now)?.text).toContain("Not valid yet.");
  });
});

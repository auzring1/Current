import { describe, expect, it } from "vitest";
import { ago, bytes, duration } from "./format";

describe("format", () => {
  it("formats bytes, including protobuf uint64 strings", () => {
    expect(bytes(0)).toBe("—");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes("17179869184")).toBe("16 GB");
  });
  it("formats relative time", () => {
    const now = Date.parse("2026-01-01T00:10:00Z");
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-01-01T00:09:30Z", now)).toBe("30s ago");
    expect(ago("2026-01-01T00:00:00Z", now)).toBe("10 min ago");
  });
  it("formats durations", () => {
    expect(duration(90061)).toBe("1d 1h");
    expect(duration(3720)).toBe("1h 2m");
  });
});

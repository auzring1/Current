import { describe, expect, it } from "vitest";
import { commandText, fileSize } from "./installCommands";

describe("commandText", () => {
  it("puts the download line above the install line", () => {
    expect(commandText({ download: "curl.exe -L -o a.msi https://x/download/a.msi", command: "msiexec /i a.msi /qn" })).toBe(
      "curl.exe -L -o a.msi https://x/download/a.msi\nmsiexec /i a.msi /qn",
    );
  });

  it("is just the install line while the server does not have the file", () => {
    expect(commandText({ download: "", command: "librepatch-agent.exe install --server h:8443 --token LP1.x" })).toBe("librepatch-agent.exe install --server h:8443 --token LP1.x");
  });
});

describe("fileSize", () => {
  it("reads like a download", () => {
    expect(fileSize(14_900_000)).toBe("14.2 MB");
    expect(fileSize(300)).toBe("1 KB");
    expect(fileSize(51_200)).toBe("50 KB");
    expect(fileSize(0)).toBe("");
    expect(fileSize(NaN)).toBe("");
  });
});

/** The commands the server returns for a new token (see POST /enrollment-tokens, "install"). */
export interface InstallCommand {
  /** curl.exe line that downloads the installer from this server; empty while the server does not have it. */
  download: string;
  command: string;
}

export interface InstallCommands {
  msi: InstallCommand;
  exe: InstallCommand;
}

/** The text to copy: the download line (when there is one) above the install line, so both can be pasted together. */
export function commandText(c: InstallCommand): string {
  return [c.download, c.command].filter((l) => l.trim() !== "").join("\n");
}

/** The size of a download the way people read it: 14.2 MB. */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

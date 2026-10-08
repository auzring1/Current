import { CopyButton } from "@mantine/core";
import { Check, Copy } from "./icons";
import { IconButton } from "./IconButton";

/** A command or token that people copy: a monospaced block (a pre) with a copy button that says "Copied" for a moment. */
export function CommandBlock({ value, label = "Copy" }: { value: string; label?: string }) {
  return (
    <div style={{ display: "flex", gap: "var(--rnv-space-2)", alignItems: "flex-start" }}>
      <pre
        tabIndex={0}
        style={{
          flex: 1,
          minWidth: 0,
          margin: 0,
          padding: "var(--rnv-space-3)",
          background: "var(--rnv-surface-sunken)",
          border: "1px solid var(--rnv-border)",
          borderRadius: "var(--rnv-radius-md)",
          color: "var(--rnv-text)",
          fontFamily: "var(--rnv-font-mono)",
          fontSize: "var(--rnv-text-sm)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {value}
      </pre>
      <CopyButton value={value}>
        {({ copied, copy }) => <IconButton label={copied ? "Copied" : label} icon={copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />} variant="default" onClick={copy} />}
      </CopyButton>
    </div>
  );
}

import type { ReactNode } from "react";

/** A label with a value below it; an empty value shows a dash. */
export function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="cur-muted" style={{ fontSize: "var(--cur-text-xs)", fontWeight: 500 }}>
        {label}
      </div>
      <div className={mono ? "cur-mono" : undefined} style={{ wordBreak: "break-word" }}>
        {value || "—"}
      </div>
    </div>
  );
}

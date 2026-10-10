import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { PillKind } from "./StatusPill";

interface TileProps {
  label: string;
  value: ReactNode;
  /** Colors the accent bar on the left. */
  kind?: PillKind | "accent";
  icon?: ReactNode;
  hint?: ReactNode;
  /** Makes the tile a link. */
  to?: string;
  /** Makes the tile a toggle button (for filtering a table). */
  onClick?: () => void;
  selected?: boolean;
}

/** A number with a label: the at-a-glance unit of the dashboards. */
export function StatTile({ label, value, kind, icon, hint, to, onClick, selected }: TileProps) {
  const cls = `cur-tile${kind ? ` cur-tile--${kind}` : ""}${selected ? " cur-tile--selected" : ""}`;
  const body = (
    <>
      <span className="cur-tile__label">
        {icon}
        {label}
      </span>
      <span className="cur-tile__value">{value}</span>
      {hint && <span className="cur-tile__hint">{hint}</span>}
    </>
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} aria-pressed={selected ?? false}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

export function StatGrid({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="cur-tiles" role="group" aria-label={label}>
      {children}
    </div>
  );
}

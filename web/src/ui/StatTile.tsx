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
  const cls = `lp-tile${kind ? ` lp-tile--${kind}` : ""}${selected ? " lp-tile--selected" : ""}`;
  const body = (
    <>
      <span className="lp-tile__label">
        {icon}
        {label}
      </span>
      <span className="lp-tile__value">{value}</span>
      {hint && <span className="lp-tile__hint">{hint}</span>}
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
    <div className="lp-tiles" role="group" aria-label={label}>
      {children}
    </div>
  );
}

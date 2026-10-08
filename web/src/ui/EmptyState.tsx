import type { ReactNode } from "react";
import { Inbox } from "./icons";

export function EmptyState({ icon, title, description, actions }: { icon?: ReactNode; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="rnv-empty">
      <div className="rnv-empty__icon" aria-hidden="true">
        {icon ?? <Inbox size={26} />}
      </div>
      <h3 className="rnv-empty__title">{title}</h3>
      {description && <p className="rnv-empty__desc">{description}</p>}
      {actions && <div className="rnv-empty__actions">{actions}</div>}
    </div>
  );
}

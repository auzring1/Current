import type { ReactNode } from "react";
import { Inbox } from "./icons";

export function EmptyState({ icon, title, description, actions }: { icon?: ReactNode; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="cur-empty">
      <div className="cur-empty__icon" aria-hidden="true">
        {icon ?? <Inbox size={26} />}
      </div>
      <h3 className="cur-empty__title">{title}</h3>
      {description && <p className="cur-empty__desc">{description}</p>}
      {actions && <div className="cur-empty__actions">{actions}</div>}
    </div>
  );
}

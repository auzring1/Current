import type { ReactNode } from "react";

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Controls on the right of the header (buttons, a segmented control...). */
  actions?: ReactNode;
  footer?: ReactNode;
  /** No padding in the body (for tables and lists that bring their own). */
  flush?: boolean;
  children?: ReactNode;
  "aria-label"?: string;
  id?: string;
}

/** A surface with an optional header and footer. Headings inside a card are h2 so the page keeps one h1. */
export function Card({ title, description, actions, footer, flush, children, id, ...rest }: CardProps) {
  return (
    <section className="cur-card" id={id} aria-label={rest["aria-label"]}>
      {(title || actions) && (
        <header className="cur-card__head">
          <div>
            {title && <h2 className="cur-card__title">{title}</h2>}
            {description && <p className="cur-card__desc">{description}</p>}
          </div>
          {actions && <div style={{ display: "flex", gap: "var(--cur-space-2)", alignItems: "center" }}>{actions}</div>}
        </header>
      )}
      <div className={flush ? "cur-card__body cur-card__body--flush" : "cur-card__body"}>{children}</div>
      {footer && <footer className="cur-card__foot">{footer}</footer>}
    </section>
  );
}

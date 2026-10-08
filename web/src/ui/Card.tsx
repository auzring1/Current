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
    <section className="rnv-card" id={id} aria-label={rest["aria-label"]}>
      {(title || actions) && (
        <header className="rnv-card__head">
          <div>
            {title && <h2 className="rnv-card__title">{title}</h2>}
            {description && <p className="rnv-card__desc">{description}</p>}
          </div>
          {actions && <div style={{ display: "flex", gap: "var(--rnv-space-2)", alignItems: "center" }}>{actions}</div>}
        </header>
      )}
      <div className={flush ? "rnv-card__body rnv-card__body--flush" : "rnv-card__body"}>{children}</div>
      {footer && <footer className="rnv-card__foot">{footer}</footer>}
    </section>
  );
}

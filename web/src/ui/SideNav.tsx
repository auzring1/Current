import { useEffect, useId } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useSession } from "../api/session";
import * as I from "./icons";
import { locate, visibleNav, type NavItem } from "./nav";
import { useNavLayout } from "./useNavLayout";

interface Props {
  onNavigate?: () => void;
  id?: string;
  /** Icon rail: labels hidden (kept for screen readers), groups and submenus not shown. */
  rail?: boolean;
}

/** The grouped, collapsible navigation. A column on wide screens, a drawer on narrow ones. */
export function SideNav({ onNavigate, id, rail = false }: Props) {
  const { can, canOrg } = useSession();
  const { layout, setOpen } = useNavLayout();
  const loc = useLocation();
  const uid = useId();
  const groups = visibleNav({ can, canOrg });
  const here = locate(loc.pathname);
  const pending = useQuery({
    queryKey: ["devices", "pending-count"],
    queryFn: () => api<{ total: number }>("GET", "/devices?status=pending&limit=1"),
    enabled: can("devices:write"),
    refetchInterval: 120_000,
  });

  // Arriving at a page inside a folded group or submenu (a link, the command palette) unfolds it, so the highlighted
  // entry is never hidden.
  const hereGroup = here?.group.id;
  const hereParent = here?.parent?.id;
  useEffect(() => {
    if (hereGroup && here?.group.label && layout.closed.includes(hereGroup)) setOpen(hereGroup, true);
    if (hereParent && layout.closed.includes(hereParent)) setOpen(hereParent, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  const link = (l: NavItem) => {
    const count = l.id === "devices" ? (pending.data?.total ?? 0) : 0;
    return (
      <NavLink to={l.to} end={l.end || !!l.children} className="rnv-nav__link" onClick={onNavigate} title={rail ? l.label : undefined} aria-describedby={count ? `${uid}-pending` : undefined}>
        <l.icon size={18} aria-hidden />
        <span className={rail ? "rnv-visually-hidden" : "rnv-nav__text"}>{l.label}</span>
        {count > 0 && !rail && (
          <span className="rnv-nav__count" aria-hidden="true">
            {count}
          </span>
        )}
      </NavLink>
    );
  };

  return (
    <nav className="rnv-nav-inner" aria-label="Main" id={id} data-rail={rail ? "true" : undefined}>
      {groups.map((g) => {
        const open = rail || !g.label || !layout.closed.includes(g.id);
        const listId = `${uid}-${g.id}`;
        return (
          <div className="rnv-nav__group" key={g.id}>
            {g.label && !rail && (
              <button type="button" className="rnv-nav__label" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(g.id, !open)}>
                <span>{g.label}</span>
                <I.ChevronDown size={14} aria-hidden className="rnv-nav__chev" data-open={open} />
              </button>
            )}
            <ul className="rnv-nav__list" id={listId} hidden={!open} aria-label={g.label || undefined}>
              {g.items.map((l) => {
                const sub = l.children && l.children.length > 0 && !rail ? l.children : null;
                const subOpen = sub ? !layout.closed.includes(l.id) : false;
                const subId = `${uid}-${l.id}-sub`;
                return (
                  <li key={l.id}>
                    {sub ? (
                      <div className="rnv-nav__split">
                        {link(l)}
                        <button type="button" className="rnv-nav__fold" aria-expanded={subOpen} aria-controls={subId} aria-label={`${l.label} submenu`} onClick={() => setOpen(l.id, !subOpen)}>
                          <I.ChevronDown size={14} aria-hidden className="rnv-nav__chev" data-open={subOpen} />
                        </button>
                      </div>
                    ) : (
                      link(l)
                    )}
                    {sub && (
                      <ul className="rnv-nav__list rnv-nav__sub" id={subId} hidden={!subOpen} aria-label={`${l.label} sections`}>
                        {sub.map((c) => (
                          <li key={c.id}>
                            <NavLink to={c.to} end={c.end} className="rnv-nav__link rnv-nav__link--sub" onClick={onNavigate}>
                              <c.icon size={16} aria-hidden />
                              <span className="rnv-nav__text">{c.label}</span>
                            </NavLink>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {(pending.data?.total ?? 0) > 0 && (
        <span id={`${uid}-pending`} className="rnv-visually-hidden">
          {pending.data!.total} devices waiting for approval
        </span>
      )}
    </nav>
  );
}

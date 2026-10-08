import { NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useSession } from "../api/session";
import { NAV } from "./nav";

/** The grouped navigation. Shown as a column on wide screens and inside a drawer on narrow ones. */
export function SideNav({ onNavigate, id }: { onNavigate?: () => void; id?: string }) {
  const { can, canOrg } = useSession();
  const pending = useQuery({
    queryKey: ["devices", "pending-count"],
    queryFn: () => api<{ total: number }>("GET", "/devices?status=pending&limit=1"),
    enabled: can("devices:write"),
    refetchInterval: 120_000,
  });
  return (
    <nav className="rnv-nav-inner" aria-label="Main" id={id}>
      {NAV.map((g) => {
        const items = g.items.filter((l) => (l.any ? can(l.perm) : canOrg(l.perm)));
        if (items.length === 0) return null;
        return (
          <div className="rnv-nav__group" key={g.label}>
            <p className="rnv-nav__label" id={`nav-${g.label}`}>
              {g.label}
            </p>
            <ul className="rnv-nav__list" aria-labelledby={`nav-${g.label}`}>
              {items.map((l) => {
                const count = l.to === "/" ? (pending.data?.total ?? 0) : 0;
                return (
                  <li key={l.to}>
                    <NavLink to={l.to} end={l.to === "/"} className="rnv-nav__link" onClick={onNavigate} aria-describedby={count ? "nav-pending" : undefined}>
                      <l.icon size={18} aria-hidden />
                      <span>{l.label}</span>
                      {count > 0 && (
                        <span className="rnv-nav__count" aria-hidden="true">
                          {count}
                        </span>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {(pending.data?.total ?? 0) > 0 && (
        <span id="nav-pending" className="rnv-visually-hidden">
          {pending.data!.total} devices waiting for approval
        </span>
      )}
    </nav>
  );
}

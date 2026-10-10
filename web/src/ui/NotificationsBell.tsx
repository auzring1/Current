import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Menu } from "@mantine/core";
import { api, type Notification } from "../api/client";
import { ago } from "../api/format";
import { useSession } from "../api/session";
import * as I from "./icons";

const ICON: Record<string, typeof I.Warning> = { failed_job: I.Danger, held_update: I.NavHeld };

/** The bell: failed jobs (24 h), and held updates that the signed-in person may act on. */
export function NotificationsBell() {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ items: Notification[]; total: number }>("GET", "/notifications"),
    enabled: !!session,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const items = q.data?.items ?? [];
  const n = items.length;
  const worst = items.some((i) => i.severity === "critical") ? "critical" : items.some((i) => i.severity === "warning") ? "warning" : "info";
  return (
    <Menu position="bottom-end" width={380} shadow="md" withinPortal>
      <Menu.Target>
        <button type="button" className="rnv-bell" aria-label={n ? `Notifications, ${n} need attention` : "Notifications, none"} data-testid="notifications">
          {n ? <I.BellRinging size={20} aria-hidden /> : <I.Bell size={20} aria-hidden />}
          {n > 0 && (
            <span className="rnv-bell__count" data-severity={worst} aria-hidden="true">
              {n > 9 ? "9+" : n}
            </span>
          )}
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Needs attention</Menu.Label>
        {q.isError && <div className="rnv-search__none">Could not load notifications.</div>}
        {!q.isError && n === 0 && <div className="rnv-search__none">{q.isLoading ? "Loading…" : "You are all caught up."}</div>}
        {items.map((i) => {
          const Icon = (i.kind && ICON[i.kind]) || I.Info;
          return (
            <Menu.Item key={i.id ?? i.title} component={Link} to={i.to ?? "/"} leftSection={<Icon size={16} aria-hidden />}>
              <div className="rnv-note__title">{i.title}</div>
              <div className="rnv-note__meta">
                {i.severity === "critical" ? "Critical · " : i.severity === "warning" ? "Warning · " : ""}
                {i.detail ? `${i.detail} · ` : ""}
                {ago(i.at ?? null)}
              </div>
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}

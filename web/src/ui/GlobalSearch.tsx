import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Device } from "../api/client";
import { useSession } from "../api/session";
import * as I from "./icons";
import { ALL_NAV_ITEMS } from "./nav";

interface Result {
  key: string;
  group: "Pages" | "Devices";
  label: string;
  hint?: string;
  to: string;
  icon: React.ReactNode;
}

/** Global search: jump to a page or a device. "/" or Ctrl+K focuses it. Device names come from the cached device list. */
export function GlobalSearch() {
  const nav = useNavigate();
  const { can, canOrg } = useSession();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();

  const devices = useQuery({
    queryKey: ["devices", "search"],
    queryFn: () => api<{ items: Device[] }>("GET", "/devices?limit=500"),
    enabled: open && can("devices:read"),
    staleTime: 60_000,
  });

  const results = useMemo<Result[]>(() => {
    const needle = q.trim().toLowerCase();
    const pages = ALL_NAV_ITEMS.filter((l) => (l.any ? can(l.perm) : canOrg(l.perm)))
      .filter((l) => !needle || l.label.toLowerCase().includes(needle))
      .slice(0, needle ? 6 : 5)
      .map<Result>((l) => ({ key: `p${l.to}`, group: "Pages", label: l.label, to: l.to, icon: <l.icon size={16} aria-hidden /> }));
    const devs = needle
      ? (devices.data?.items ?? [])
          .filter((d) => [d.hostname, d.logged_on_user, d.serial, d.model, d.os_caption].some((v) => v?.toLowerCase().includes(needle)))
          .slice(0, 8)
          .map<Result>((d) => ({ key: `d${d.id}`, group: "Devices", label: d.hostname, hint: d.logged_on_user || d.os_caption || d.status, to: `/devices/${d.id}`, icon: <I.Laptop size={16} aria-hidden /> }))
      : [];
    return [...pages, ...devs];
  }, [q, devices.data, can, canOrg]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = /^(input|textarea|select)$/i.test((e.target as HTMLElement)?.tagName ?? "") || (e.target as HTMLElement)?.isContentEditable;
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
    };
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => (window.removeEventListener("keydown", onKey), window.removeEventListener("mousedown", onDown));
  }, []);

  const go = (r: Result) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    nav(r.to);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setOpen(true), setActive((a) => Math.min(a + 1, results.length - 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
    else if (e.key === "Enter" && open && results[active]) (e.preventDefault(), go(results[active]!));
    else if (e.key === "Escape") (setOpen(false), input.current?.blur());
  };

  let lastGroup = "";
  return (
    <div className="rnv-search" ref={wrap} role="search">
      <div className="rnv-search__field">
        <I.Search size={16} aria-hidden />
        <input
          ref={input}
          className="rnv-search__input"
          type="text"
          role="combobox"
          aria-label="Global search"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
          placeholder="Search pages and devices"
          autoComplete="off"
          value={q}
          onChange={(e) => (setQ(e.currentTarget.value), setOpen(true))}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <kbd className="rnv-kbd" aria-hidden="true">
          /
        </kbd>
      </div>
      {open && (
        <div className="rnv-search__panel" id={listId} role="listbox" aria-label="Search results">
          {results.length === 0 && <div className="rnv-search__none">{devices.isFetching ? "Searching…" : "No matches"}</div>}
          {results.map((r, i) => {
            const head = r.group !== lastGroup ? ((lastGroup = r.group), <div className="rnv-search__group" role="presentation">{r.group}</div>) : null;
            return (
              <div key={r.key} role="presentation">
                {head}
                <button type="button" id={`${listId}-${i}`} role="option" aria-selected={i === active} className="rnv-search__item" tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => go(r)}>
                  {r.icon}
                  <span>{r.label}</span>
                  {r.hint && <small>{r.hint}</small>}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

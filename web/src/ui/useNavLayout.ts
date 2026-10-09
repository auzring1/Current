import { useCallback, useMemo, useState } from "react";
import { usePreferences } from "../design/usePreferences";

export interface NavLayout {
  /** Narrowed to an icon rail. */
  collapsed: boolean;
  /** Ids of folded groups and submenus. */
  closed: string[];
}

const KEY = "rnv-nav";
const read = (): NavLayout => {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<NavLayout>;
    return { collapsed: v.collapsed === true, closed: Array.isArray(v.closed) ? v.closed.filter((x) => typeof x === "string") : [] };
  } catch {
    return { collapsed: false, closed: [] };
  }
};
const write = (l: NavLayout) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* private mode: the account copy still works */
  }
};

/**
 * How the person arranged the sidebar. It is kept on their account (so it follows them to any device) and mirrored on
 * this device so the first paint is already right.
 */
export function useNavLayout() {
  const { prefs, ready, update } = usePreferences();
  const [local, setLocal] = useState<NavLayout>(read);
  const layout = useMemo<NavLayout>(() => (ready && prefs?.nav ? { collapsed: prefs.nav.collapsed ?? false, closed: prefs.nav.closed ?? [] } : local), [ready, prefs?.nav, local]);

  const save = useCallback(
    (next: NavLayout) => {
      write(next);
      setLocal(next);
      if (ready) update({ nav: next });
    },
    [ready, update],
  );
  const setCollapsed = useCallback((collapsed: boolean) => save({ ...layout, collapsed }), [layout, save]);
  const setOpen = useCallback((id: string, open: boolean) => save({ ...layout, closed: open ? layout.closed.filter((x) => x !== id) : [...new Set([...layout.closed, id])] }), [layout, save]);
  return { layout, setCollapsed, setOpen };
}

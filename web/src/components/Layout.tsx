import { useState } from "react";
import { ActionIcon, Drawer } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, setCsrf } from "../api/client";
import { useLiveEvents } from "../api/events";
import { useSession } from "../api/session";
import { BrandMark, useBranding, useDocumentTitle } from "../branding/BrandingProvider";
import { forgetLocalAppearance } from "../design/AppearanceProvider";
import { GlobalSearch } from "../ui/GlobalSearch";
import * as I from "../ui/icons";
import { ALL_NAV_ITEMS } from "../ui/nav";
import { SideNav } from "../ui/SideNav";
import { UserMenu } from "../ui/UserMenu";
import "../ui/ui.css";

export function Layout() {
  const { session, can } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const brand = useBranding();
  const loc = useLocation();
  const narrow = useMediaQuery("(max-width: 62em)", false) ?? false;
  const [drawer, setDrawer] = useState(false);
  useLiveEvents(can("devices:read"));

  const logout = async () => {
    await api("POST", "/auth/logout", {}).catch(() => undefined);
    setCsrf("");
    forgetLocalAppearance();
    // Drop everything cached for the old user, but keep the session query itself so the mounted
    // provider sees "signed out" at once (clear() would detach it and leave a stale session). The public
    // branding is not user data, and its provider stays mounted, so it must stay in the cache too.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" && q.queryKey[0] !== "branding" });
    qc.setQueryData(["session"], null);
    nav("/login", { replace: true });
  };

  const here = [...ALL_NAV_ITEMS].sort((a, b) => b.to.length - a.to.length).find((l) => (l.to === "/" ? loc.pathname === "/" || loc.pathname.startsWith("/devices") : loc.pathname.startsWith(l.to)));
  useDocumentTitle(here?.label ?? (loc.pathname.startsWith("/account") ? "Account" : undefined));

  return (
    <div className="rnv-shell">
      <a className="rnv-skip-link" href="#main">
        Skip to main content
      </a>
      <header className="rnv-topbar">
        {narrow && (
          <ActionIcon variant="subtle" color="gray" size="lg" onClick={() => setDrawer(true)} aria-label="Open navigation" aria-expanded={drawer} aria-controls="mobile-nav">
            <I.Menu size={20} aria-hidden />
          </ActionIcon>
        )}
        <Link to="/" className="rnv-topbar__brand" aria-label={`${brand.product_name} home`}>
          <BrandMark height={28} />
          <span className="rnv-topbar__product" data-testid="product-name">
            {brand.product_name}
          </span>
          <span className="rnv-topbar__org" data-testid="org-name">
            {brand.org_name || session?.org.name}
          </span>
        </Link>
        <div className="rnv-topbar__search">
          <GlobalSearch />
        </div>
        <span className="rnv-topbar__spacer" />
        <div className="rnv-topbar__right">
          <UserMenu name={session?.user.display_name ?? ""} email={session?.user.email ?? ""} onSignOut={() => void logout()} />
        </div>
      </header>
      {!narrow && (
        <div className="rnv-nav rnv-nav--static">
          <SideNav />
        </div>
      )}
      {narrow && (
        <Drawer opened={drawer} onClose={() => setDrawer(false)} size={290} padding="sm" title="Navigation" id="mobile-nav" withinPortal>
          <SideNav onNavigate={() => setDrawer(false)} />
        </Drawer>
      )}
      <main id="main" className="rnv-main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}

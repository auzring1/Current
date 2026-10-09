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
import { CommandPaletteProvider, SearchButton } from "../ui/CommandPalette";
import { NotificationsBell } from "../ui/NotificationsBell";
import { SiteScopeProvider } from "../ui/SiteScope";
import { SiteSwitcher } from "../ui/SiteSwitcher";
import { useNavLayout } from "../ui/useNavLayout";
import * as I from "../ui/icons";
import { locate } from "../ui/nav";
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
  const { layout, setCollapsed } = useNavLayout();
  const rail = !narrow && layout.collapsed;
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

  const here = locate(loc.pathname)?.item;
  useDocumentTitle(here?.label ?? (loc.pathname.startsWith("/account") ? "Account" : undefined));

  return (
    <SiteScopeProvider>
    <CommandPaletteProvider>
    <div className="rnv-shell" data-rail={rail ? "true" : undefined}>
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
        <SiteSwitcher />
        <div className="rnv-topbar__search">
          <SearchButton />
        </div>
        <span className="rnv-topbar__spacer" />
        <div className="rnv-topbar__right">
          <NotificationsBell />
          <UserMenu name={session?.user.display_name ?? ""} email={session?.user.email ?? ""} onSignOut={() => void logout()} />
        </div>
      </header>
      {!narrow && (
        <div className="rnv-nav rnv-nav--static">
          <SideNav rail={rail} />
          <div className="rnv-nav__foot">
            <button type="button" className="rnv-nav__link rnv-nav__rail-toggle" onClick={() => setCollapsed(!rail)} aria-pressed={rail} title={rail ? "Expand sidebar" : undefined} data-testid="nav-rail-toggle">
              {rail ? <I.SidebarExpand size={18} aria-hidden /> : <I.SidebarCollapse size={18} aria-hidden />}
              <span className={rail ? "rnv-visually-hidden" : "rnv-nav__text"}>{rail ? "Expand sidebar" : "Collapse sidebar"}</span>
            </button>
          </div>
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
    </CommandPaletteProvider>
    </SiteScopeProvider>
  );
}

import { AppShell, Burger, Button, Group, NavLink, Text, useMantineTheme } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { NavLink as RouterLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, setCsrf } from "../api/client";
import { useLiveEvents } from "../api/events";
import { useSession } from "../api/session";
import { BrandMark, useBranding, useDocumentTitle } from "../branding/BrandingProvider";
import { decorColor } from "../branding/theme";

export function Layout() {
  const { session, can, canOrg } = useSession();
  const [opened, { toggle }] = useDisclosure();
  const nav = useNavigate();
  const qc = useQueryClient();
  useLiveEvents(can("devices:read"));
  const brand = useBranding();
  const theme = useMantineTheme();
  const loc = useLocation();

  const logout = async () => {
    await api("POST", "/auth/logout", {}).catch(() => undefined);
    setCsrf("");
    // Drop everything cached for the old user, but keep the session query itself so the mounted
    // provider sees "signed out" at once (clear() would detach it and leave a stale session). The public
    // branding is not user data, and its provider stays mounted, so it must stay in the cache too.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" && q.queryKey[0] !== "branding" });
    qc.setQueryData(["session"], null);
    nav("/login", { replace: true });
  };

  const links = [
    { to: "/", label: "Devices", perm: "devices:read", any: true },
    { to: "/software", label: "Software", perm: "devices:read" },
    { to: "/groups", label: "Groups", perm: "groups:read" },
    { to: "/catalog", label: "Catalog", perm: "catalog:read" },
    { to: "/updates", label: "Windows updates", perm: "updates:read" },
    { to: "/update-policy", label: "Update policy", perm: "updates:read" },
    { to: "/policies", label: "Software policies", perm: "policies:read" },
    { to: "/reports", label: "Reports", perm: "reports:read" },
    { to: "/agent-updates", label: "Agent updates", perm: "releases:read" },
    { to: "/deployments", label: "Deployments", perm: "deployments:read" },
    { to: "/enrollment", label: "Enrollment", perm: "enrollment:read" },
    { to: "/audit", label: "Audit log", perm: "audit:read" },
    { to: "/sites", label: "Sites", perm: "sites:write" },
    { to: "/users", label: "Users", perm: "users:read" },
    { to: "/license", label: "License", perm: "license:write" },
    { to: "/settings", label: "Settings", perm: "catalog:read" },
  ];

  const here = [...links].sort((a, b) => b.to.length - a.to.length).find((l) => (l.to === "/" ? loc.pathname === "/" || loc.pathname.startsWith("/devices") : loc.pathname.startsWith(l.to)));
  useDocumentTitle(here?.label ?? (loc.pathname.startsWith("/account") ? "Account" : undefined));

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header style={{ borderBottom: `3px solid ${decorColor(theme, brand.secondary_color)}` }}>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <BrandMark height={32} />
            <Text fw={700} data-testid="product-name">
              {brand.product_name}
            </Text>
            <Text c="dimmed" size="sm" data-testid="org-name">
              {brand.org_name || session?.org.name}
            </Text>
          </Group>
          <Group>
            <Button component={RouterLink} to="/account" size="xs" variant="subtle">
              {session?.user.display_name}
            </Button>
            <Button size="xs" variant="default" onClick={() => void logout()}>
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {links
          .filter((l) => ("any" in l && l.any ? can(l.perm) : canOrg(l.perm)))
          .map((l) => (
            <NavLink key={l.to} component={RouterLink} to={l.to} end={l.to === "/"} label={l.label} />
          ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

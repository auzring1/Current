import { AppShell, Burger, Button, Group, NavLink, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { NavLink as RouterLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, setCsrf } from "../api/client";
import { useLiveEvents } from "../api/events";
import { useSession } from "../api/session";

export function Layout() {
  const { session, can, canOrg } = useSession();
  const [opened, { toggle }] = useDisclosure();
  const nav = useNavigate();
  const qc = useQueryClient();
  useLiveEvents(can("devices:read"));

  const logout = async () => {
    await api("POST", "/auth/logout", {}).catch(() => undefined);
    setCsrf("");
    // Drop everything cached for the old user, but keep the session query itself so the mounted
    // provider sees "signed out" at once (clear() would detach it and leave a stale session).
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" });
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
    { to: "/agent-updates", label: "Agent updates", perm: "releases:read" },
    { to: "/deployments", label: "Deployments", perm: "deployments:read" },
    { to: "/enrollment", label: "Enrollment", perm: "enrollment:read" },
    { to: "/audit", label: "Audit log", perm: "audit:read" },
    { to: "/sites", label: "Sites", perm: "sites:write" },
    { to: "/users", label: "Users", perm: "users:read" },
    { to: "/settings", label: "Settings", perm: "catalog:read" },
  ];

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <Text fw={700}>Auzring</Text>
            <Text c="dimmed" size="sm">
              {session?.org.name}
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

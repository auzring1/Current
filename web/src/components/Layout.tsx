import { AppShell, Burger, Button, Group, NavLink, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { NavLink as RouterLink, Outlet, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, setCsrf } from "../api/client";
import { useLiveEvents } from "../api/events";
import { useSession } from "../api/session";

export function Layout() {
  const { session, can } = useSession();
  const [opened, { toggle }] = useDisclosure();
  const nav = useNavigate();
  const qc = useQueryClient();
  useLiveEvents(can("devices:read"));

  const logout = async () => {
    await api("POST", "/auth/logout", {}).catch(() => undefined);
    setCsrf("");
    qc.clear();
    nav("/login", { replace: true });
  };

  const links = [
    { to: "/", label: "Devices", perm: "devices:read" },
    { to: "/software", label: "Software", perm: "devices:read" },
    { to: "/groups", label: "Groups", perm: "groups:read" },
    { to: "/enrollment", label: "Enrollment", perm: "enrollment:read" },
    { to: "/audit", label: "Audit log", perm: "audit:read" },
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
            <Text size="sm">{session?.user.display_name}</Text>
            <Button size="xs" variant="default" onClick={() => void logout()}>
              Sign out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        {links
          .filter((l) => can(l.perm))
          .map((l) => (
            <NavLink key={l.to} component={RouterLink} to={l.to} end label={l.label} />
          ))}
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

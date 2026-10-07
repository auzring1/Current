import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Checkbox, Drawer, Group, Loader, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { api, errorMessage, type SoftwareTitle, type TitleInstall } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";

interface TitleDetail {
  id: string;
  name: string;
  publisher: string;
  versions: { version: string; device_count: number }[];
}

export function SoftwarePage() {
  const { can } = useSession();
  const [text, setText] = useState("");
  const [q] = useDebouncedValue(text.trim(), 250);
  const [system, setSystem] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["software", "list", q, system],
    queryFn: () => api<{ items: SoftwareTitle[]; total: number }>("GET", `/software?limit=200&q=${encodeURIComponent(q)}${system ? "&include_system=true" : ""}`),
  });
  const csv = `/api/v1/reports/software.csv?q=${encodeURIComponent(q)}${system ? "&include_system=true" : ""}`;

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={2}>Software</Title>
        {can("inventory:export") && (
          <Button component="a" href={csv} variant="default" download>
            Export CSV
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        Everything installed across your devices, grouped by product. Open a product to see which versions are out there and where.
      </Text>
      <Group mb="md">
        <TextInput placeholder="Search products or publishers" value={text} onChange={(e) => setText(e.currentTarget.value)} w={320} aria-label="Search software" />
        <Checkbox label="Include system components" checked={system} onChange={(e) => setSystem(e.currentTarget.checked)} />
      </Group>
      {list.isLoading && <Loader />}
      {list.error && <Alert color="red">{errorMessage(list.error)}</Alert>}
      {list.data && list.data.items.length === 0 && <Alert color="blue">No matching software yet. Devices report software shortly after they connect.</Alert>}
      {list.data && list.data.items.length > 0 && (
        <Table.ScrollContainer minWidth={600}>
          <Table highlightOnHover verticalSpacing="xs" aria-label="Software">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Product</Table.Th>
                <Table.Th>Publisher</Table.Th>
                <Table.Th ta="right">Devices</Table.Th>
                <Table.Th ta="right">Versions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.items.map((t) => (
                <Table.Tr key={t.id} onClick={() => setSelected(t.id)} style={{ cursor: "pointer" }} data-testid="title-row">
                  <Table.Td fw={500}>{t.name}</Table.Td>
                  <Table.Td>{t.publisher || "—"}</Table.Td>
                  <Table.Td ta="right">{t.device_count}</Table.Td>
                  <Table.Td ta="right">{t.version_count}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {list.data.total > list.data.items.length && (
            <Text size="sm" c="dimmed" mt="xs">
              Showing {list.data.items.length} of {list.data.total}. Narrow the search to see the rest.
            </Text>
          )}
        </Table.ScrollContainer>
      )}
      <TitleDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function TitleDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useSession();
  const [version, setVersion] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ["software", "title", id], queryFn: () => api<TitleDetail>("GET", `/software/${id}`), enabled: !!id });
  const installs = useQuery({
    queryKey: ["software", "installs", id, version],
    queryFn: () => api<{ items: TitleInstall[]; total: number }>("GET", `/software/${id}/installs?limit=500${version ? `&version=${encodeURIComponent(version)}` : ""}`),
    enabled: !!id,
  });
  const d = detail.data;
  return (
    <Drawer
      opened={!!id}
      onClose={() => {
        setVersion(null);
        onClose();
      }}
      position="right"
      size="xl"
      title={d?.name ?? "Software"}
    >
      {detail.isLoading && <Loader />}
      {detail.error && <Alert color="red">{errorMessage(detail.error)}</Alert>}
      {d && (
        <Stack>
          <Text size="sm" c="dimmed">
            {d.publisher || "Unknown publisher"}
          </Text>
          <Title order={5}>Versions</Title>
          <Table aria-label="Versions" verticalSpacing={4} fz="sm">
            <Table.Tbody>
              {d.versions.map((v) => (
                <Table.Tr key={v.version} onClick={() => setVersion(version === v.version ? null : v.version)} style={{ cursor: "pointer" }}>
                  <Table.Td ff="monospace">
                    {v.version || "(unknown)"}
                    {version === v.version && (
                      <Badge ml="xs" size="xs">
                        filtered
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">{v.device_count} devices</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Group justify="space-between">
            <Title order={5}>Devices{version ? ` with ${version}` : ""}</Title>
            {can("inventory:export") && (
              <Button component="a" size="xs" variant="default" href={`/api/v1/reports/software.csv?title_id=${id}`} download>
                Export CSV
              </Button>
            )}
          </Group>
          {installs.isLoading && <Loader />}
          {installs.data && (
            <Table aria-label="Devices with this software" verticalSpacing={4} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Device</Table.Th>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Scope</Table.Th>
                  <Table.Th>Last seen</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {installs.data.items.map((i, n) => (
                  <Table.Tr key={`${i.device_id}-${n}`}>
                    <Table.Td>
                      <Anchor component={Link} to={`/devices/${i.device_id}`} size="sm">
                        {i.hostname}
                      </Anchor>
                    </Table.Td>
                    <Table.Td ff="monospace">{i.version || "—"}</Table.Td>
                    <Table.Td>{i.scope}</Table.Td>
                    <Table.Td>{dateTime(i.last_seen_at)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      )}
    </Drawer>
  );
}


import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Checkbox, Group, Loader, Modal, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  api,
  errorMessage,
  type Device,
  type DeviceSoftware,
  type DeviceUser,
  type SoftwareChange,
} from "../api/client";
import { ago, bytes, dateTime, duration } from "../api/format";
import { useSession } from "../api/session";
import { OnlineDot, StatusBadge } from "../components/common";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ wordBreak: "break-word" }}>
        {value || "—"}
      </Text>
    </div>
  );
}

const bitlockerColor: Record<string, string> = { protected: "green", unprotected: "red", encrypting: "yellow", decrypting: "yellow" };

export function DevicePage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["device", id], queryFn: () => api<Device>("GET", `/devices/${id}`), enabled: !!id });
  const refresh = () => qc.invalidateQueries({ queryKey: ["devices"] }).then(() => qc.invalidateQueries({ queryKey: ["device", id] }));
  const approve = useMutation({
    mutationFn: () => api("POST", `/devices/${id}/approve`, {}),
    onSuccess: () => (notifications.show({ color: "green", message: "Device approved." }), refresh()),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: () => api("POST", `/devices/${id}/revoke`, { reason }),
    onSuccess: () => (setRevokeOpen(false), setReason(""), notifications.show({ color: "green", message: "Device revoked and disconnected." }), refresh()),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const d = q.data;
  const hw = d?.hardware;

  return (
    <>
      <Anchor component={Link} to="/" size="sm">
        ← Devices
      </Anchor>
      <Title order={2} mb="sm">
        {d?.hostname ?? "Device"}
      </Title>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {d && (
        <Stack>
          <Group>
            <StatusBadge status={d.status} />
            {d.status === "active" && <OnlineDot online={d.online} />}
            {d.pending_reboot && <Text c="orange">Reboot pending</Text>}
          </Group>
          {d.status === "pending" && d.replaces_device_id && (
            <Alert color="yellow" title="Re-enrollment of known hardware">
              This device has the same hardware identity as an existing device. Approving it revokes the old identity ({d.replaces_device_id}).
            </Alert>
          )}
          {d.status === "revoked" && d.status_reason && <Alert color="red">Revoked: {d.status_reason}</Alert>}
          {can("devices:write") && (
            <Group>
              {d.status === "pending" && (
                <Button onClick={() => approve.mutate()} loading={approve.isPending}>
                  Approve
                </Button>
              )}
              {(d.status === "pending" || d.status === "active") && (
                <Button color="red" variant="light" onClick={() => setRevokeOpen(true)}>
                  {d.status === "pending" ? "Reject" : "Revoke"}
                </Button>
              )}
            </Group>
          )}
          <Tabs defaultValue="overview" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              <Tabs.Tab value="hardware">Hardware</Tabs.Tab>
              <Tabs.Tab value="software">Software{d.software_count ? ` (${d.software_count})` : ""}</Tabs.Tab>
              <Tabs.Tab value="users">Users</Tabs.Tab>
              <Tabs.Tab value="certificates">Client certificates</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="overview" pt="md">
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Field label="Device ID" value={d.id} />
                <Field label="Last seen" value={d.online ? "connected now" : ago(d.last_seen_at)} />
                <Field label="Operating system" value={`${d.os_caption ?? ""} ${hw?.os_display_version ?? ""}`} />
                <Field label="Build" value={d.os_build} />
                <Field label="Logged-on user" value={d.logged_on_user} />
                <Field label="Last logged-on user" value={hw?.last_logged_on_user} />
                <Field label="Uptime" value={duration(d.uptime_s)} />
                <Field label="IP (last connection)" value={d.last_ip} />
                <Field label="Agent version" value={d.agent_version} />
                <Field label="Enrolled" value={dateTime(d.enrolled_at)} />
                <Field label="Software inventory" value={d.software_updated_at ? `${d.software_count} items, updated ${ago(d.software_updated_at)}` : "not reported yet"} />
              </SimpleGrid>
            </Tabs.Panel>

            <Tabs.Panel value="hardware" pt="md">
              {!hw && <Text c="dimmed">No hardware inventory reported yet.</Text>}
              {hw && (
                <Stack>
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Field label="Manufacturer" value={hw.manufacturer} />
                    <Field label="Model" value={hw.model} />
                    <Field label="Serial number" value={hw.serial} />
                    <Field label="Chassis" value={hw.chassis} />
                    <Field label="CPU" value={`${hw.cpu_model ?? ""} (${hw.cpu_logical_cores ?? "?"} logical cores)`} />
                    <Field label="Memory" value={bytes(hw.ram_bytes)} />
                    <Field label="BIOS" value={hw.bios_version} />
                    <Field label="Domain" value={hw.domain} />
                    <Field label="Architecture" value={hw.arch} />
                    <Field label="Time zone" value={hw.timezone} />
                  </SimpleGrid>
                  {!!hw.disks?.length && (
                    <Table aria-label="Disks">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Disk</Table.Th>
                          <Table.Th>File system</Table.Th>
                          <Table.Th>Size</Table.Th>
                          <Table.Th>Free</Table.Th>
                          <Table.Th>BitLocker</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {hw.disks.map((k) => (
                          <Table.Tr key={k.mount}>
                            <Table.Td>{k.mount}</Table.Td>
                            <Table.Td>{k.filesystem}</Table.Td>
                            <Table.Td>{bytes(k.size_bytes)}</Table.Td>
                            <Table.Td>{bytes(k.free_bytes)}</Table.Td>
                            <Table.Td>
                              {k.bitlocker ? (
                                <Badge color={bitlockerColor[k.bitlocker] ?? "gray"} variant="light">
                                  {k.bitlocker}
                                </Badge>
                              ) : (
                                "—"
                              )}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                  {!!hw.interfaces?.length && (
                    <Table aria-label="Network interfaces">
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Interface</Table.Th>
                          <Table.Th>MAC</Table.Th>
                          <Table.Th>Addresses</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {hw.interfaces.map((n) => (
                          <Table.Tr key={n.name}>
                            <Table.Td>{n.name}</Table.Td>
                            <Table.Td>{n.mac}</Table.Td>
                            <Table.Td>{n.addresses?.join(", ")}</Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </Stack>
              )}
            </Tabs.Panel>

            <Tabs.Panel value="software" pt="md">
              <SoftwareTab id={id} />
            </Tabs.Panel>

            <Tabs.Panel value="users" pt="md">
              <UsersTab id={id} />
            </Tabs.Panel>

            <Tabs.Panel value="certificates" pt="md">
              {!d.certificates?.length && <Text c="dimmed">No certificates.</Text>}
              {!!d.certificates?.length && (
                <Table aria-label="Certificates">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Serial</Table.Th>
                      <Table.Th>Expires</Table.Th>
                      <Table.Th>State</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.certificates.map((c) => (
                      <Table.Tr key={c.serial}>
                        <Table.Td ff="monospace" fz="xs">
                          {c.serial.slice(0, 16)}…
                        </Table.Td>
                        <Table.Td>{dateTime(c.not_after)}</Table.Td>
                        <Table.Td>{c.revoked_at ? "revoked" : "valid"}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}
      <Modal opened={revokeOpen} onClose={() => setRevokeOpen(false)} title="Revoke device">
        <Stack>
          <Text size="sm">
            The device is disconnected immediately and can never reconnect with its current identity. To manage it again, reinstall the agent
            with a new enrollment token.
          </Text>
          <TextInput label="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} maxLength={500} />
          <Button color="red" onClick={() => revoke.mutate()} loading={revoke.isPending}>
            Revoke device
          </Button>
        </Stack>
      </Modal>
    </>
  );
}

function SoftwareTab({ id }: { id: string }) {
  const [system, setSystem] = useState(false);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState(false);
  const q = useQuery({
    queryKey: ["device", id, "software", system],
    queryFn: () =>
      api<{ items: DeviceSoftware[]; total: number; truncated: boolean; updated_at: string | null }>(
        "GET",
        `/devices/${id}/software${system ? "?include_system=true" : ""}`,
      ),
  });
  const hist = useQuery({
    queryKey: ["device", id, "software-history"],
    queryFn: () => api<{ items: SoftwareChange[] }>("GET", `/devices/${id}/software/history?limit=100`),
    enabled: history,
  });
  const users = useQuery({ queryKey: ["device", id, "users"], queryFn: () => api<{ items: DeviceUser[] }>("GET", `/devices/${id}/users`) });
  const who = (sid: string) => {
    if (!sid) return "all users";
    const u = users.data?.items.find((x) => x.sid === sid);
    return u ? (u.domain ? `${u.domain}\\${u.username}` : u.username) : sid;
  };
  const f = filter.trim().toLowerCase();
  const rows = (q.data?.items ?? []).filter((s) => !f || s.name.toLowerCase().includes(f) || (s.publisher ?? "").toLowerCase().includes(f));

  return (
    <Stack>
      {q.data?.truncated && <Alert color="yellow">The agent reported only part of this device's software (item limit reached).</Alert>}
      <Group justify="space-between">
        <TextInput placeholder="Filter by name or publisher" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} w={280} aria-label="Filter software" />
        <Group>
          <Checkbox label="Show system components" checked={system} onChange={(e) => setSystem(e.currentTarget.checked)} />
          <Checkbox label="Change history" checked={history} onChange={(e) => setHistory(e.currentTarget.checked)} />
        </Group>
      </Group>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && rows.length === 0 && <Text c="dimmed">No software reported yet.</Text>}
      {rows.length > 0 && (
        <Table.ScrollContainer minWidth={700}>
          <Table aria-label="Installed software" verticalSpacing={4} fz="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Publisher</Table.Th>
                <Table.Th>Installed for</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Installed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((s) => (
                <Table.Tr key={`${s.source}|${s.scope}|${s.user_sid}|${s.name}|${s.version}`} data-testid="software-row">
                  <Table.Td>{s.name}</Table.Td>
                  <Table.Td ff="monospace">{s.version || "—"}</Table.Td>
                  <Table.Td>{s.publisher || "—"}</Table.Td>
                  <Table.Td>{who(s.user_sid ?? "")}</Table.Td>
                  <Table.Td>
                    <Badge variant="light" color="gray" size="sm">
                      {s.source}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{s.install_date || dateTime(s.first_seen_at)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {history && (
        <>
          <Title order={5}>Recent changes</Title>
          {hist.isLoading && <Loader />}
          {hist.data && hist.data.items.length === 0 && <Text c="dimmed">No changes recorded since the first report.</Text>}
          {!!hist.data?.items.length && (
            <Table aria-label="Software changes" verticalSpacing={4} fz="sm">
              <Table.Tbody>
                {hist.data.items.map((h) => (
                  <Table.Tr key={h.id}>
                    <Table.Td>{dateTime(h.observed_at)}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color={h.change === "added" ? "green" : h.change === "removed" ? "red" : "blue"} size="sm">
                        {h.change}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{h.name}</Table.Td>
                    <Table.Td ff="monospace">{h.change === "version" ? `${h.old_version} → ${h.new_version}` : h.change === "added" ? h.new_version : h.old_version}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
    </Stack>
  );
}

function UsersTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["device", id, "users"], queryFn: () => api<{ items: DeviceUser[] }>("GET", `/devices/${id}/users`) });
  if (q.isLoading) return <Loader />;
  if (q.error) return <Alert color="red">{errorMessage(q.error)}</Alert>;
  if (!q.data?.items.length) return <Text c="dimmed">No user profiles reported yet.</Text>;
  return (
    <Table.ScrollContainer minWidth={600}>
      <Table aria-label="Users" verticalSpacing={4} fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>User</Table.Th>
            <Table.Th>Last logon</Table.Th>
            <Table.Th>State</Table.Th>
            <Table.Th>Profile</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {q.data.items.map((u) => (
            <Table.Tr key={u.sid}>
              <Table.Td>
                {u.domain ? `${u.domain}\\${u.username}` : u.username}
                {u.is_admin && (
                  <Badge ml="xs" size="xs" color="orange" variant="light">
                    admin
                  </Badge>
                )}
                <Text size="xs" c="dimmed" ff="monospace">
                  {u.sid}
                </Text>
              </Table.Td>
              <Table.Td>{u.last_logon_at ? dateTime(u.last_logon_at) : "—"}</Table.Td>
              <Table.Td>{u.loaded ? "signed in" : "—"}</Table.Td>
              <Table.Td ff="monospace" fz="xs">
                {u.profile_path || "—"}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  api,
  errorMessage,
  type Device,
  type DeviceJob,
  type DeviceUser,
} from "../api/client";
import { ago, bytes, dateTime, duration } from "../api/format";
import { useSession } from "../api/session";
import { OnlineDot, StatusBadge } from "../components/common";
import { JobBadge } from "./DeploymentsPage";
import { MissingUpdatesTab, SoftwareTab } from "../components/DeviceSoftware";
import { JobModal } from "./DeploymentPage";

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
  const refreshDevice = useMutation({
    mutationFn: async () => {
      const { job_id } = await api<{ job_id: string }>("POST", `/devices/${id}/refresh`, {});
      // The agent answers within seconds; wait for the job so the page can show fresh data.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const j = await api<{ status: string }>("GET", `/jobs/${job_id}`);
        if (["succeeded", "succeeded_reboot", "failed", "expired", "cancelled", "rejected"].includes(j.status)) return j.status;
      }
      return "timeout";
    },
    onSuccess: (status) => {
      void qc.invalidateQueries({ queryKey: ["devices"] });
      void qc.invalidateQueries({ queryKey: ["device", id] });
      void qc.invalidateQueries({ queryKey: ["device-jobs", id] });
      notifications.show(
        status === "succeeded"
          ? { color: "green", message: "Device information refreshed." }
          : { color: "yellow", message: "The device did not confirm the refresh in time. It will update when the device reports." },
      );
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const nav = useNavigate();
  const del = useMutation({
    mutationFn: () => api("DELETE", `/devices/${id}`),
    onSuccess: () => {
      notifications.show({ color: "green", message: "Device deleted." });
      void qc.invalidateQueries({ queryKey: ["devices"] });
      nav("/");
    },
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
              {d.status === "active" && (
                <Tooltip label={d.online ? "Ask the device to send its hardware, software and user information now" : "The device is offline"}>
                  <Button variant="default" onClick={() => refreshDevice.mutate()} loading={refreshDevice.isPending} disabled={!d.online}>
                    ↻ Refresh
                  </Button>
                </Tooltip>
              )}
              {(d.status === "pending" || d.status === "active") && (
                <Button color="red" variant="light" onClick={() => setRevokeOpen(true)}>
                  {d.status === "pending" ? "Reject" : "Revoke"}
                </Button>
              )}
              {(d.status === "revoked" || d.status === "retired") && (
                <Button color="red" variant="light" onClick={() => setDeleteOpen(true)}>
                  Delete device
                </Button>
              )}
            </Group>
          )}
          <Tabs defaultValue="overview" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              <Tabs.Tab value="hardware">Hardware</Tabs.Tab>
              {can("deployments:read") && <Tabs.Tab value="updates">Missing updates</Tabs.Tab>}
              <Tabs.Tab value="software">Software{d.software_count ? ` (${d.software_count})` : ""}</Tabs.Tab>
              <Tabs.Tab value="users">Users</Tabs.Tab>
              {can("deployments:read") && <Tabs.Tab value="jobs">Jobs</Tabs.Tab>}
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

            {can("deployments:read") && (
              <Tabs.Panel value="updates" pt="md">
                <MissingUpdatesTab id={id} hostname={d.hostname} active={d.status === "active"} />
              </Tabs.Panel>
            )}

            <Tabs.Panel value="software" pt="md">
              <SoftwareTab id={id} hostname={d.hostname} active={d.status === "active"} />
            </Tabs.Panel>

            <Tabs.Panel value="users" pt="md">
              <UsersTab id={id} />
            </Tabs.Panel>

            {can("deployments:read") && (
              <Tabs.Panel value="jobs" pt="md">
                <JobsTab id={id} />
              </Tabs.Panel>
            )}

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
      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete device">
        <Stack>
          <Text size="sm">
            This removes {d?.hostname} and everything stored about it: hardware, software inventory, user profiles, jobs and client certificates. The audit log keeps
            the record that it existed. This cannot be undone. If the machine still has the agent, uninstall it first or it will need a new enrollment token.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => del.mutate()} loading={del.isPending}>
              Delete permanently
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
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

function JobsTab({ id }: { id: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["device-jobs", id], queryFn: () => api<{ items: DeviceJob[] }>("GET", `/devices/${id}/jobs`), refetchInterval: 30_000 });
  return (
    <>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && q.data.items.length === 0 && <Alert color="blue">No jobs have been sent to this device.</Alert>}
      {!!q.data?.items.length && (
        <Table verticalSpacing="xs" fz="sm" aria-label="Device jobs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Job</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.items.map((j) => (
              <Table.Tr key={j.id}>
                <Table.Td>
                  {j.deployment_id ? (
                    <Anchor component={Link} to={`/deployments/${j.deployment_id}`} size="sm">
                      {j.title}
                    </Anchor>
                  ) : (
                    j.title
                  )}
                </Table.Td>
                <Table.Td>
                  <JobBadge status={j.status} />
                  {j.status_reason && (
                    <Text size="xs" c="dimmed">
                      {j.status_reason}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{dateTime(j.created_at)}</Table.Td>
                <Table.Td ta="right">
                  <Button size="compact-xs" variant="default" onClick={() => setOpen(j.id)}>
                    Details
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {open && <JobModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

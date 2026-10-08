import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Anchor, Button, Modal, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Tooltip } from "@mantine/core";
import {
  api,
  errorMessage,
  type Device,
  type DeviceJob,
  type DeviceUser,
} from "../api/client";
import { ago, bytes, dateTime, duration } from "../api/format";
import { useSession } from "../api/session";
import { JobBadge } from "./DeploymentsPage";
import { MissingUpdatesTab, SoftwareTab } from "../components/DeviceSoftware";
import { WindowsUpdatesTab } from "../components/DeviceWindowsUpdates";
import { JobModal } from "./DeploymentPage";
import { Card, EmptyState, Icons, Page, PageHeader, StatGrid, StatTile, Status, StatusPill, TableSkeleton, toast, useConfirm } from "../ui";

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="rnv-muted" style={{ fontSize: "var(--rnv-text-xs)", fontWeight: 500 }}>
        {label}
      </div>
      <div className={mono ? "rnv-mono" : undefined} style={{ wordBreak: "break-word" }}>
        {value || "—"}
      </div>
    </div>
  );
}

const bitlockerKind: Record<string, "success" | "danger" | "warning"> = { protected: "success", unprotected: "danger", encrypting: "warning", decrypting: "warning" };

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
    onSuccess: () => (toast.success("Device approved."), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: () => api("POST", `/devices/${id}/revoke`, { reason }),
    onSuccess: () => (setRevokeOpen(false), setReason(""), toast.success("Device revoked and disconnected."), refresh()),
    onError: (e) => toast.error(errorMessage(e)),
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
      if (status === "succeeded") toast.success("Device information refreshed.");
      else toast.warning("The device did not confirm the refresh in time. It will update when the device reports.");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const confirm = useConfirm();
  const nav = useNavigate();
  const del = useMutation({
    mutationFn: () => api("DELETE", `/devices/${id}`),
    onSuccess: () => {
      toast.success("Device deleted.");
      void qc.invalidateQueries({ queryKey: ["devices"] });
      nav("/");
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data;
  const hw = d?.hardware;

  return (
    <Page>
      <PageHeader
        title={d?.hostname ?? "Device"}
        breadcrumbs={[{ label: "Devices", to: "/" }, { label: d?.hostname ?? "Device" }]}
        description={d ? [d.os_caption, d.os_build].filter(Boolean).join(" · ") || undefined : undefined}
        actions={
          d && can("devices:write") ? (
            <>
              {d.status === "pending" && (
                <Button onClick={() => approve.mutate()} loading={approve.isPending} leftSection={<Icons.Check size={16} aria-hidden />}>
                  Approve
                </Button>
              )}
              {d.status === "active" && (
                <Tooltip label={d.online ? "Ask the device to send its hardware, software and user information now" : "The device is offline"}>
                  <Button variant="default" onClick={() => refreshDevice.mutate()} loading={refreshDevice.isPending} disabled={!d.online} leftSection={<Icons.NavAgentUpdates size={16} aria-hidden />}>
                    Refresh
                  </Button>
                </Tooltip>
              )}
              {(d.status === "pending" || d.status === "active") && (
                <Button color="red" variant="light" onClick={() => setRevokeOpen(true)} leftSection={<Icons.Danger size={16} aria-hidden />}>
                  {d.status === "pending" ? "Reject" : "Revoke"}
                </Button>
              )}
              {(d.status === "revoked" || d.status === "retired") && (
                <Button
                  color="red"
                  variant="light"
                  leftSection={<Icons.Trash size={16} aria-hidden />}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete device",
                      message: `This removes ${d.hostname} and everything stored about it: hardware, software inventory, user profiles, jobs and client certificates. The audit log keeps the record that it existed. This cannot be undone. If the machine still has the agent, uninstall it first or it will need a new enrollment token.`,
                      confirmLabel: "Delete permanently",
                      danger: true,
                    });
                    if (ok) del.mutate();
                  }}
                >
                  Delete device
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      {q.isLoading && <TableSkeleton rows={4} cols={3} />}
      {q.error && <Alert color="red" icon={<Icons.Danger size={18} aria-hidden />}>{errorMessage(q.error)}</Alert>}
      {d && (
        <>
          <StatGrid label="Device summary">
            <StatTile label="Status" value={<Status value={d.status} />} kind={d.status === "active" ? "success" : d.status === "pending" ? "warning" : d.status === "revoked" ? "danger" : "neutral"} />
            {d.status === "active" && <StatTile label="Connection" value={<Status value={d.online ? "online" : "offline"} />} kind={d.online ? "success" : "neutral"} hint={d.online ? "connected now" : `last seen ${ago(d.last_seen_at)}`} />}
            <StatTile label="Restart" value={d.pending_reboot ? <StatusPill kind="warning" icon={Icons.Restart}>Pending</StatusPill> : <StatusPill kind="success">Not needed</StatusPill>} kind={d.pending_reboot ? "warning" : "success"} />
            <StatTile label="Software" value={<span className="rnv-num">{d.software_count || "—"}</span>} kind="accent" hint={d.software_updated_at ? `updated ${ago(d.software_updated_at)}` : "not reported yet"} />
            <StatTile label="Uptime" value={<span style={{ fontSize: "var(--rnv-text-2xl)" }}>{duration(d.uptime_s)}</span>} kind="info" hint={d.agent_version ? `agent ${d.agent_version}` : undefined} />
          </StatGrid>
          {d.status === "pending" && d.replaces_device_id && (
            <Alert color="yellow" icon={<Icons.Warning size={18} aria-hidden />} title="Re-enrollment of known hardware">
              This device has the same hardware identity as an existing device. Approving it revokes the old identity ({d.replaces_device_id}).
            </Alert>
          )}
          {d.status === "revoked" && d.status_reason && (
            <Alert color="red" icon={<Icons.Danger size={18} aria-hidden />}>
              Revoked: {d.status_reason}
            </Alert>
          )}
          <Card flush>
          <Tabs defaultValue="overview" keepMounted={false} style={{ padding: "var(--rnv-space-2) var(--rnv-space-4) var(--rnv-space-4)" }}>
            <Tabs.List>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              <Tabs.Tab value="hardware">Hardware</Tabs.Tab>
              {can("deployments:read") && <Tabs.Tab value="updates">Missing updates</Tabs.Tab>}
              {can("updates:read") && <Tabs.Tab value="winupdates">Windows updates</Tabs.Tab>}
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
              {!hw && <EmptyState icon={<Icons.Server size={26} />} title="No hardware inventory yet" description="The device reports its hardware a few minutes after it first connects." />}
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
                                <StatusPill kind={bitlockerKind[k.bitlocker] ?? "neutral"} size="sm" icon={k.bitlocker === "protected" ? Icons.Lock : undefined}>
                                  {k.bitlocker[0]!.toUpperCase() + k.bitlocker.slice(1)}
                                </StatusPill>
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

            {can("updates:read") && (
              <Tabs.Panel value="winupdates" pt="md">
                <WindowsUpdatesTab id={id} active={d.status === "active"} />
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
              {!d.certificates?.length && <EmptyState icon={<Icons.Lock size={26} />} title="No certificates" />}
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
                        <Table.Td>{c.revoked_at ? <StatusPill kind="danger" size="sm">Revoked</StatusPill> : <StatusPill kind="success" size="sm">Valid</StatusPill>}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </Tabs.Panel>
          </Tabs>
          </Card>
        </>
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
    </Page>
  );
}

function UsersTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["device", id, "users"], queryFn: () => api<{ items: DeviceUser[] }>("GET", `/devices/${id}/users`) });
  if (q.isLoading) return <TableSkeleton rows={3} cols={4} />;
  if (q.error) return <Alert color="red" icon={<Icons.Danger size={18} aria-hidden />}>{errorMessage(q.error)}</Alert>;
  if (!q.data?.items.length) return <EmptyState icon={<Icons.NavUsers size={26} />} title="No user profiles reported yet" />;
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
                  <span style={{ marginLeft: 8 }}>
                    <StatusPill kind="warning" size="sm" icon={Icons.Shield}>
                      Admin
                    </StatusPill>
                  </span>
                )}
                <Text size="xs" c="dimmed" ff="monospace">
                  {u.sid}
                </Text>
              </Table.Td>
              <Table.Td>{u.last_logon_at ? dateTime(u.last_logon_at) : "—"}</Table.Td>
              <Table.Td>{u.loaded ? <StatusPill kind="success" size="sm" icon={Icons.Online}>Signed in</StatusPill> : "—"}</Table.Td>
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
      {q.isLoading && <TableSkeleton rows={3} cols={4} />}
      {q.error && <Alert color="red" icon={<Icons.Danger size={18} aria-hidden />}>{errorMessage(q.error)}</Alert>}
      {q.data && q.data.items.length === 0 && <EmptyState icon={<Icons.NavDeployments size={26} />} title="No jobs yet" description="Jobs sent to this device by deployments and update rules appear here." />}
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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Checkbox, Group, Loader, Menu, Modal, SegmentedControl, Select, Stack, Table, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type RestartPolicy, type WindowsUpdate } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";

const classifications = ["Security Updates", "Critical Updates", "Definition Updates", "Drivers", "Feature Packs", "Service Packs", "Update Rollups", "Updates", "Upgrades", "Tools"];

export const severityColor: Record<string, string> = { Critical: "red", Important: "orange", Moderate: "yellow", Low: "gray" };

export function DecisionBadge({ u }: { u: Pick<WindowsUpdate, "decision" | "decision_source"> }) {
  const color = { approved: "green", declined: "gray", hidden: "violet", "": "blue" }[u.decision] ?? "gray";
  const label = u.decision === "" ? "pending" : u.decision;
  return (
    <Tooltip label={u.decision_source === "rule" ? "Approved automatically by a rule" : u.decision ? "Decided by an administrator" : "Waiting for a decision"}>
      <Badge variant="light" color={color}>
        {label}
        {u.decision_source === "rule" ? " (rule)" : ""}
      </Badge>
    </Tooltip>
  );
}

const PAGE = 50;

export function UpdatesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [classification, setClassification] = useState<string | null>(null);
  const [severity, setSeverity] = useState<string | null>(null);
  const [decision, setDecision] = useState("all");
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<WindowsUpdate | null>(null);
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (q.trim()) params.set("q", q.trim());
  if (classification) params.set("classification", classification);
  if (severity) params.set("severity", severity);
  if (decision !== "all") params.set("decision", decision);
  if (onlyMissing) params.set("missing", "true");
  const list = useQuery({
    queryKey: ["updates", "list", params.toString()],
    queryFn: () => api<{ items: WindowsUpdate[]; total: number }>("GET", `/updates?${params}`),
    refetchInterval: 60_000,
  });
  const decide = useMutation({
    mutationFn: ({ ids, d }: { ids: string[]; d: string }) => api<{ changed: number; hide_jobs: number }>("POST", "/updates/decision", { update_ids: ids, decision: d }),
    onSuccess: (r, v) => {
      notifications.show({ color: "green", message: `${r.changed} update${r.changed === 1 ? "" : "s"} ${v.d === "none" ? "reset to pending" : v.d}${r.hide_jobs ? `; ${r.hide_jobs} device job${r.hide_jobs === 1 ? "" : "s"} queued` : ""}.` });
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["updates"] });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const rows = list.data?.items ?? [];
  const canDecide = can("updates:write");
  const allSelected = rows.length > 0 && rows.every((u) => selected.has(u.update_id));
  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const reset = () => (setOffset(0), setSelected(new Set()));

  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Windows updates</Title>
        {can("updates:policy") && (
          <Button component={Link} to="/update-policy" variant="default">
            Rings, rules and sources
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Everything Windows Update has offered your devices. Approve an update and the rings install it, pilot first. Updates stay untouched until you approve them or a rule does.
      </Text>
      <Group mb="sm" align="flex-end">
        <TextInput label="Search" placeholder="Title or KB number" value={q} onChange={(e) => (setQ(e.currentTarget.value), reset())} w={240} />
        <Select label="Classification" data={classifications} value={classification} onChange={(v) => (setClassification(v), reset())} clearable placeholder="Any" w={200} />
        <Select label="Severity" data={["Critical", "Important", "Moderate", "Low"]} value={severity} onChange={(v) => (setSeverity(v), reset())} clearable placeholder="Any" w={140} />
        <SegmentedControl
          value={decision}
          onChange={(v) => (setDecision(v), reset())}
          data={[
            { value: "all", label: "All" },
            { value: "pending", label: "Pending" },
            { value: "approved", label: "Approved" },
            { value: "declined", label: "Declined" },
            { value: "hidden", label: "Hidden" },
          ]}
        />
        <Checkbox label="Only updates some device is missing" checked={onlyMissing} onChange={(e) => (setOnlyMissing(e.currentTarget.checked), reset())} />
      </Group>
      {canDecide && selected.size > 0 && (
        <Group mb="sm">
          <Button onClick={() => decide.mutate({ ids: [...selected], d: "approved" })} loading={decide.isPending}>
            Approve
          </Button>
          <Button variant="default" onClick={() => decide.mutate({ ids: [...selected], d: "declined" })}>
            Decline
          </Button>
          <Button variant="default" onClick={() => decide.mutate({ ids: [...selected], d: "hidden" })}>
            Hide on devices
          </Button>
          <Button variant="subtle" onClick={() => decide.mutate({ ids: [...selected], d: "none" })}>
            Reset to pending
          </Button>
          <Text size="sm" c="dimmed">
            {selected.size} selected
          </Text>
        </Group>
      )}
      {list.isLoading && <Loader />}
      {list.error && <Alert color="red">{errorMessage(list.error)}</Alert>}
      {list.data && rows.length === 0 && (
        <Alert color="blue" title="No updates to show">
          Devices report what Windows Update offers shortly after they connect and then every day. Open a device and use <b>Windows updates → Scan now</b> to ask for it right away.
        </Alert>
      )}
      {rows.length > 0 && (
        <Table.ScrollContainer minWidth={980}>
          <Table highlightOnHover verticalSpacing="xs" fz="sm" aria-label="Windows updates">
            <Table.Thead>
              <Table.Tr>
                {canDecide && (
                  <Table.Th w={36}>
                    <Checkbox aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((u) => u.update_id)))} />
                  </Table.Th>
                )}
                <Table.Th>Update</Table.Th>
                <Table.Th>Classification</Table.Th>
                <Table.Th>Severity</Table.Th>
                <Table.Th>Released</Table.Th>
                <Table.Th>Devices</Table.Th>
                <Table.Th>Decision</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((u) => (
                <Table.Tr key={u.update_id} data-testid="update-row">
                  {canDecide && (
                    <Table.Td>
                      <Checkbox aria-label={`Select ${u.title}`} checked={selected.has(u.update_id)} onChange={() => toggle(u.update_id)} />
                    </Table.Td>
                  )}
                  <Table.Td maw={420}>
                    <Anchor component="button" type="button" size="sm" ta="left" onClick={() => setOpen(u)}>
                      {u.title}
                    </Anchor>
                    <Group gap={4}>
                      {(u.kb ?? []).map((k) => (
                        <Badge key={k} size="xs" variant="outline" color="gray">
                          KB{k.replace(/^KB/i, "")}
                        </Badge>
                      ))}
                      {u.is_driver && (
                        <Badge size="xs" variant="light" color="grape">
                          driver
                        </Badge>
                      )}
                      {(u.holds ?? 0) > 0 && (
                        <Tooltip label="A ring failed its success threshold; later rings are held back. See Rings, rules and sources.">
                          <Badge size="xs" color="red" variant="filled">
                            held
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>{u.classification || "—"}</Table.Td>
                  <Table.Td>
                    {u.severity ? (
                      <Badge variant="light" color={severityColor[u.severity] ?? "gray"}>
                        {u.severity}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </Table.Td>
                  <Table.Td>{u.release_date ? new Date(u.release_date).toLocaleDateString() : "—"}</Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      <b>{u.devices_missing}</b> missing
                      {(u.devices_pending_reboot ?? 0) > 0 && <>, {u.devices_pending_reboot} need a restart</>}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {u.devices_installed} installed{(u.devices_failed ?? 0) > 0 && <Text span c="red"> · {u.devices_failed} failed</Text>}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <DecisionBadge u={u} />
                  </Table.Td>
                  <Table.Td ta="right">
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target>
                        <Button size="compact-xs" variant="subtle" aria-label={`Actions for ${u.title}`}>
                          ⋮
                        </Button>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item onClick={() => setOpen(u)}>Devices and details</Menu.Item>
                        {canDecide && (
                          <>
                            <Menu.Divider />
                            <Menu.Item disabled={u.decision === "approved"} onClick={() => decide.mutate({ ids: [u.update_id], d: "approved" })}>
                              Approve
                            </Menu.Item>
                            <Menu.Item disabled={u.decision === "declined"} onClick={() => decide.mutate({ ids: [u.update_id], d: "declined" })}>
                              Decline
                            </Menu.Item>
                            <Menu.Item disabled={u.decision === "hidden"} onClick={() => decide.mutate({ ids: [u.update_id], d: "hidden" })}>
                              Hide on devices
                            </Menu.Item>
                            <Menu.Item disabled={u.decision === ""} onClick={() => decide.mutate({ ids: [u.update_id], d: "none" })}>
                              Reset to pending
                            </Menu.Item>
                          </>
                        )}
                      </Menu.Dropdown>
                    </Menu>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {list.data && list.data.total > PAGE && (
        <Group mt="md">
          <Button variant="default" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Previous
          </Button>
          <Text size="sm" c="dimmed">
            {offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {list.data.total}
          </Text>
          <Button variant="default" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>
            Next
          </Button>
        </Group>
      )}
      {open && <UpdateDetail u={open} onClose={() => setOpen(null)} />}
    </>
  );
}

const restartOptions = [
  { value: "never", label: "Do not restart (the device keeps asking to be restarted)" },
  { value: "outside_active_hours", label: "Restart outside 08:00–17:00 with a 15 minute notice" },
];

function UpdateDetail({ u, onClose }: { u: WindowsUpdate; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [restart, setRestart] = useState("never");
  const q = useQuery({
    queryKey: ["updates", "devices", u.update_id],
    queryFn: () =>
      api<{
        items: { device_id: string; hostname: string; online: boolean; state: string; last_error: string; attempt_state: string; attempt_failures: number; ring: string }[];
      }>("GET", `/updates/${u.update_id}/devices?limit=1000`),
  });
  const install = useMutation({
    mutationFn: (deviceIds: string[]) => {
      const r: RestartPolicy = restart === "never" ? { allow: "never" } : { allow: "outside_active_hours", active_start: 8 * 60, active_end: 17 * 60, notify_minutes: 15 };
      return api<{ jobs: number }>("POST", `/updates/${u.update_id}/install`, { device_ids: deviceIds, restart: r });
    },
    onSuccess: (r) => {
      notifications.show({ color: "green", message: `Install queued on ${r.jobs} device${r.jobs === 1 ? "" : "s"}.` });
      void qc.invalidateQueries({ queryKey: ["updates"] });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const missing = (q.data?.items ?? []).filter((d) => d.state === "missing" || d.state === "downloaded");
  return (
    <Modal opened onClose={onClose} title={u.title} size="xl">
      <Stack>
        <Group gap="xs">
          <DecisionBadge u={u} />
          {u.severity && <Badge color={severityColor[u.severity] ?? "gray"}>{u.severity}</Badge>}
          <Text size="sm" c="dimmed">
            {u.classification} · released {u.release_date ? new Date(u.release_date).toLocaleDateString() : "unknown"} · first seen {dateTime(u.first_seen_at)}
            {u.reboot_required ? " · needs a restart" : ""}
          </Text>
        </Group>
        {u.note && <Text size="sm">Note: {u.note}</Text>}
        {u.support_url && (
          <Anchor href={u.support_url} target="_blank" rel="noopener noreferrer" size="sm">
            Microsoft support article
          </Anchor>
        )}
        {q.isLoading && <Loader />}
        {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
        {q.data && (
          <Table aria-label="Devices with this update" verticalSpacing={2} fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Device</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Ring</Table.Th>
                <Table.Th>Last install attempt</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {q.data.items.map((d) => (
                <Table.Tr key={d.device_id}>
                  <Table.Td>
                    <Anchor component={Link} to={`/devices/${d.device_id}`} size="sm">
                      {d.hostname}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>{d.state.replace("_", " ")}</Table.Td>
                  <Table.Td>{d.ring || "—"}</Table.Td>
                  <Table.Td>
                    {d.attempt_state ? `${d.attempt_state}${d.attempt_failures ? ` (${d.attempt_failures} failure${d.attempt_failures === 1 ? "" : "s"})` : ""}` : "—"}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {can("updates:write") && missing.length > 0 && (
          <Group align="flex-end">
            <Select label="After installing" data={restartOptions} value={restart} onChange={(v) => setRestart(v ?? "never")} allowDeselect={false} style={{ flex: 1 }} />
            <Button onClick={() => window.confirm(`Install this update now on ${missing.length} device${missing.length === 1 ? "" : "s"}, ignoring the rings?`) && install.mutate(missing.map((d) => d.device_id))} loading={install.isPending}>
              Install now on {missing.length} device{missing.length === 1 ? "" : "s"}
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}

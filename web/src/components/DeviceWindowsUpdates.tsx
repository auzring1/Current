import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Checkbox, Group, Loader, Modal, NumberInput, Select, Stack, Table, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type DeviceWindowsUpdates, type RestartPolicy } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";
import { DecisionBadge, severityColor } from "../pages/UpdatesPage";

const doneStates = ["succeeded", "succeeded_reboot", "failed", "expired", "cancelled", "rejected"];

async function waitForJob(jobID: string, seconds: number): Promise<string> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const j = await api<{ status: string }>("GET", `/jobs/${jobID}`);
    if (doneStates.includes(j.status)) return j.status;
  }
  return "timeout";
}

const stateColor: Record<string, string> = { missing: "blue", downloaded: "cyan", hidden: "violet", pending_reboot: "orange", failed: "red" };
const stateLabel: Record<string, string> = { missing: "missing", downloaded: "downloaded", hidden: "hidden", pending_reboot: "needs restart", failed: "failed" };

type Item = DeviceWindowsUpdates["items"][number];

export function WindowsUpdatesTab({ id, active }: { id: string; active: boolean }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const canAct = can("updates:write") && active;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installOpen, setInstallOpen] = useState(false);
  const [restartOpen, setRestartOpen] = useState(false);
  const q = useQuery({ queryKey: ["updates", "device", id], queryFn: () => api<DeviceWindowsUpdates>("GET", `/devices/${id}/windows-updates`) });
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["updates"] });
    void qc.invalidateQueries({ queryKey: ["device-jobs", id] });
  };
  const scan = useMutation({
    mutationFn: async () => {
      const { job_id } = await api<{ job_id: string }>("POST", `/devices/${id}/windows-updates/scan`, {});
      return waitForJob(job_id, 180);
    },
    onSuccess: (s) => {
      done();
      notifications.show(s === "succeeded" ? { color: "green", message: "Scan finished." } : s === "timeout" ? { color: "yellow", message: "The scan is still running. The list updates when the device reports." } : { color: "red", message: `The scan ended as ${s}. See the Jobs tab.` });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const install = useMutation({
    mutationFn: ({ ids, restart }: { ids: string[]; restart: RestartPolicy }) => api<{ job_id: string }>("POST", `/devices/${id}/windows-updates/install`, { update_ids: ids, restart }),
    onSuccess: () => (setInstallOpen(false), setSelected(new Set()), done(), notifications.show({ color: "green", message: "Install queued. Follow it on the Jobs tab." })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const hide = useMutation({
    mutationFn: ({ ids, hide }: { ids: string[]; hide: boolean }) => api<{ job_id: string }>("POST", `/devices/${id}/windows-updates/hide`, { update_ids: ids, hide }),
    onSuccess: (_, v) => (setSelected(new Set()), done(), notifications.show({ color: "green", message: v.hide ? "Hide queued." : "Unhide queued." })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const reboot = useMutation({
    mutationFn: (minutes: number) => api<{ job_id: string }>("POST", `/devices/${id}/reboot`, { minutes, reason: "Restart requested by an administrator" }),
    onSuccess: () => (setRestartOpen(false), done(), notifications.show({ color: "green", message: "Restart queued. Signed-in users see a countdown." })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });

  if (q.isLoading) return <Loader />;
  if (q.error) return <Alert color="red">{errorMessage(q.error)}</Alert>;
  const d = q.data!;
  const items = d.items;
  const sel = items.filter((i) => selected.has(i.update_id));
  const installable = sel.filter((i) => i.state !== "hidden" && i.state !== "pending_reboot");
  const toggle = (u: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(u)) n.delete(u);
      else n.add(u);
      return n;
    });
  const p = d.policy;
  const managed = p && (p.wsus_configured || p.wufb_deferrals || p.no_auto_update || p.wu_service_disabled);

  return (
    <Stack>
      {managed && (
        <Alert color="yellow" title="Windows updates on this device are managed by another policy">
          <Text size="sm">
            Effective source: <b>{p.effective_source || "unknown"}</b>
            {p.wsus_configured && p.wsus_server ? ` (${p.wsus_server})` : ""}.
          </Text>
          {(p.notes ?? []).length > 0 && (
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {(p.notes ?? []).map((n) => (
                <li key={n}>
                  <Text size="sm">{n}</Text>
                </li>
              ))}
            </ul>
          )}
          <Text size="sm" mt={4}>
            Auzring does not change these policies. Installs can be delayed or blocked until you change them (for example with Group Policy).
          </Text>
        </Alert>
      )}
      {d.reboot_required && (
        <Alert color="orange" title="This device is waiting for a restart">
          <Group justify="space-between">
            <Text size="sm">Windows needs a restart to finish installing updates.</Text>
            {canAct && (
              <Button size="xs" color="orange" onClick={() => setRestartOpen(true)}>
                Restart now…
              </Button>
            )}
          </Group>
        </Alert>
      )}
      {d.scan_error && (
        <Alert color="red" title="The last scan failed">
          {d.scan_error}
        </Alert>
      )}
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {d.scanned_at ? `Last scan ${dateTime(d.scanned_at)}` : "This device has not reported a scan yet."}
          {d.truncated ? " The list is cut off; the device has more updates than it reports." : ""}
        </Text>
        <Group>
          {canAct && sel.length > 0 && (
            <>
              <Button size="xs" onClick={() => setInstallOpen(true)} disabled={installable.length === 0}>
                Install selected
              </Button>
              <Button size="xs" variant="default" onClick={() => hide.mutate({ ids: sel.filter((i) => i.state !== "hidden").map((i) => i.update_id), hide: true })} disabled={sel.every((i) => i.state === "hidden")}>
                Hide
              </Button>
              <Button size="xs" variant="default" onClick={() => hide.mutate({ ids: sel.filter((i) => i.state === "hidden").map((i) => i.update_id), hide: false })} disabled={!sel.some((i) => i.state === "hidden")}>
                Unhide
              </Button>
            </>
          )}
          {canAct && (
            <Button size="xs" variant="default" onClick={() => scan.mutate()} loading={scan.isPending}>
              Scan now
            </Button>
          )}
        </Group>
      </Group>
      {d.scanned_at && items.length === 0 && <Alert color="green">Nothing is missing on this device.</Alert>}
      {items.length > 0 && (
        <Table.ScrollContainer minWidth={760}>
          <Table highlightOnHover verticalSpacing="xs" fz="sm" aria-label="Windows updates on this device">
            <Table.Thead>
              <Table.Tr>
                {canAct && (
                  <Table.Th w={36}>
                    <Checkbox aria-label="Select all" checked={sel.length === items.length} onChange={() => setSelected(sel.length === items.length ? new Set() : new Set(items.map((i) => i.update_id)))} />
                  </Table.Th>
                )}
                <Table.Th>Update</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Severity</Table.Th>
                <Table.Th>Approval</Table.Th>
                <Table.Th>Rollout</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.map((i) => (
                <Table.Tr key={i.update_id}>
                  {canAct && (
                    <Table.Td>
                      <Checkbox aria-label={`Select ${i.title}`} checked={selected.has(i.update_id)} onChange={() => toggle(i.update_id)} />
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Text size="sm">{i.title}</Text>
                    <Group gap={4}>
                      {(i.kb ?? []).map((k) => (
                        <Badge key={k} size="xs" variant="outline" color="gray">
                          KB{k.replace(/^KB/i, "")}
                        </Badge>
                      ))}
                      {i.is_driver && (
                        <Badge size="xs" variant="light" color="grape">
                          driver
                        </Badge>
                      )}
                      {i.classification && (
                        <Text size="xs" c="dimmed">
                          {i.classification}
                        </Text>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={i.last_error || ""} disabled={!i.last_error}>
                      <Badge variant="light" color={stateColor[i.state] ?? "gray"}>
                        {stateLabel[i.state] ?? i.state}
                      </Badge>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    {i.severity ? (
                      <Badge variant="light" color={severityColor[i.severity] ?? "gray"}>
                        {i.severity}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </Table.Td>
                  <Table.Td>
                    <DecisionBadge u={{ decision: (i.decision ?? "") as "" | "approved" | "declined" | "hidden", decision_source: "" }} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{i.attempt_state || "—"}</Text>
                    {(i.attempt_failures ?? 0) > 0 && (
                      <Text size="xs" c="red">
                        {i.attempt_failures} failed attempt{i.attempt_failures === 1 ? "" : "s"}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {installOpen && <InstallModal items={installable} busy={install.isPending} onCancel={() => setInstallOpen(false)} onConfirm={(restart) => install.mutate({ ids: installable.map((i) => i.update_id), restart })} />}
      {restartOpen && <RestartModal busy={reboot.isPending} onCancel={() => setRestartOpen(false)} onConfirm={(m) => reboot.mutate(m)} />}
    </Stack>
  );
}

function InstallModal({ items, busy, onCancel, onConfirm }: { items: Item[]; busy: boolean; onCancel: () => void; onConfirm: (r: RestartPolicy) => void }) {
  const [restart, setRestart] = useState("never");
  return (
    <Modal opened onClose={onCancel} title={`Install ${items.length} update${items.length === 1 ? "" : "s"} now`}>
      <Stack>
        <Text size="sm">This installs right away on this device, whatever the approval state and rings say.</Text>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {items.map((i) => (
            <li key={i.update_id}>
              <Text size="sm">{i.title}</Text>
            </li>
          ))}
        </ul>
        <Select
          label="After installing"
          data={[
            { value: "never", label: "Do not restart (the device keeps asking to be restarted)" },
            { value: "outside_active_hours", label: "Restart outside 08:00–17:00 with a 15 minute notice" },
          ]}
          value={restart}
          onChange={(v) => setRestart(v ?? "never")}
          allowDeselect={false}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => onConfirm(restart === "never" ? { allow: "never" } : { allow: "outside_active_hours", active_start: 8 * 60, active_end: 17 * 60, notify_minutes: 15 })}>
            Install
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RestartModal({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: (minutes: number) => void }) {
  const [minutes, setMinutes] = useState<number | string>(15);
  return (
    <Modal opened onClose={onCancel} title="Restart this device">
      <Stack>
        <Text size="sm">Signed-in users see a countdown first and can ask you to wait; an administrator on the device can abort it with <code>shutdown /a</code>.</Text>
        <NumberInput label="Countdown (minutes)" min={1} max={1440} value={minutes} onChange={setMinutes} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button color="orange" loading={busy} onClick={() => onConfirm(Number(minutes) || 15)}>
            Restart
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

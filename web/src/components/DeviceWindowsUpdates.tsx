import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Group, Modal, NumberInput, Select, Stack, Text, Tooltip } from "@mantine/core";
import { api, errorMessage, type DeviceWindowsUpdates, type RestartPolicy } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";
import { PRODUCT_NAME } from "../brand.generated";
import { DataTable, EmptyState, Icons, SeverityBadge, StatusPill, TableSkeleton, toast, type Column, type PillKind } from "../ui";
import { DecisionPill } from "../ui/DecisionPill";

const doneStates = ["succeeded", "succeeded_reboot", "failed", "expired", "cancelled", "rejected"];

async function waitForJob(jobID: string, seconds: number): Promise<string> {
  for (let i = 0; i < seconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const j = await api<{ status: string }>("GET", `/jobs/${jobID}`);
    if (doneStates.includes(j.status)) return j.status;
  }
  return "timeout";
}

const stateKind: Record<string, PillKind> = { missing: "info", downloaded: "info", hidden: "neutral", pending_reboot: "warning", failed: "danger" };
const stateLabel: Record<string, string> = { missing: "Missing", downloaded: "Downloaded", hidden: "Hidden", pending_reboot: "Needs restart", failed: "Failed" };
const stateIcon: Record<string, typeof Icons.Info> = { missing: Icons.ArrowDown, downloaded: Icons.Download, hidden: Icons.EyeOff, pending_reboot: Icons.Restart, failed: Icons.Danger };

export type Item = DeviceWindowsUpdates["items"][number];

/** Invalidates what a finished action may have changed. */
function useRefreshAfter(id: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["updates"] });
    void qc.invalidateQueries({ queryKey: ["device-jobs", id] });
  };
}

export const windowsUpdatesKey = (id: string) => ["updates", "device", id] as const;
export const fetchWindowsUpdates = (id: string) => api<DeviceWindowsUpdates>("GET", `/devices/${id}/windows-updates`);
/** Updates that "install now" can act on: not hidden and not already waiting for a restart. */
export const installable = (items: Item[]) => items.filter((i) => i.state !== "hidden" && i.state !== "pending_reboot");

/** Asks the device to scan for Windows updates and waits for the answer. */
export function useScanUpdates(id: string) {
  const done = useRefreshAfter(id);
  return useMutation({
    mutationFn: async () => {
      const { job_id } = await api<{ job_id: string }>("POST", `/devices/${id}/windows-updates/scan`, {});
      return waitForJob(job_id, 180);
    },
    onSuccess: (s) => {
      done();
      if (s === "succeeded") toast.success("Scan finished.");
      else if (s === "timeout") toast.warning("The scan is still running. The list updates when the device reports.");
      else toast.error(`The scan ended as ${s}. See the Jobs tab.`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Installs the chosen Windows updates now. Callers close their dialog with the `mutate` callbacks. */
export function useInstallUpdates(id: string) {
  const done = useRefreshAfter(id);
  return useMutation({
    mutationFn: ({ ids, restart }: { ids: string[]; restart: RestartPolicy }) => api<{ job_id: string }>("POST", `/devices/${id}/windows-updates/install`, { update_ids: ids, restart }),
    onSuccess: () => (done(), toast.success("Install queued. Follow it on the Jobs tab.")),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

/** Restarts the device after a countdown. */
export function useRebootDevice(id: string) {
  const done = useRefreshAfter(id);
  return useMutation({
    mutationFn: (minutes: number) => api<{ job_id: string }>("POST", `/devices/${id}/reboot`, { minutes, reason: "Restart requested by an administrator" }),
    onSuccess: () => (done(), toast.success("Restart queued. Signed-in users see a countdown.")),
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function WindowsUpdatesTab({ id, active }: { id: string; active: boolean }) {
  const { can } = useSession();
  const done = useRefreshAfter(id);
  const canAct = can("updates:write") && active;
  const [installFor, setInstallFor] = useState<{ items: Item[]; clear: () => void } | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const q = useQuery({ queryKey: windowsUpdatesKey(id), queryFn: () => fetchWindowsUpdates(id) });
  const scan = useScanUpdates(id);
  const install = useInstallUpdates(id);
  const hide = useMutation({
    mutationFn: ({ ids, hide }: { ids: string[]; hide: boolean; clear: () => void }) => api<{ job_id: string }>("POST", `/devices/${id}/windows-updates/hide`, { update_ids: ids, hide }),
    onSuccess: (_, v) => (v.clear(), done(), toast.success(v.hide ? "Hide queued." : "Unhide queued.")),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reboot = useRebootDevice(id);

  const columns = useMemo<Column<Item>[]>(
    () => [
      {
        id: "title",
        header: "Update",
        value: (i) => `${i.title} ${(i.kb ?? []).join(" ")}`,
        required: true,
        wrap: true,
        width: 380,
        csv: (i) => i.title,
        cell: (i) => (
          <>
            <div>{i.title}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4, alignItems: "center" }}>
              {(i.kb ?? []).map((k) => (
                <StatusPill key={k} kind="neutral" size="sm" icon={null}>
                  KB{k.replace(/^KB/i, "")}
                </StatusPill>
              ))}
              {i.is_driver && (
                <StatusPill kind="info" size="sm" icon={Icons.Server}>
                  Driver
                </StatusPill>
              )}
              {i.classification && <span className="rnv-muted" style={{ fontSize: "var(--rnv-text-xs)" }}>{i.classification}</span>}
            </div>
          </>
        ),
      },
      {
        id: "state",
        header: "State",
        value: (i) => i.state,
        width: 150,
        filter: { type: "select", options: Object.entries(stateLabel).map(([value, label]) => ({ value, label })) },
        cell: (i) => (
          <Tooltip label={i.last_error || ""} disabled={!i.last_error}>
            <span>
              <StatusPill kind={stateKind[i.state] ?? "neutral"} size="sm" icon={stateIcon[i.state]}>
                {stateLabel[i.state] ?? i.state}
              </StatusPill>
            </span>
          </Tooltip>
        ),
      },
      {
        id: "severity",
        header: "Severity",
        value: (i) => i.severity ?? "",
        width: 130,
        cell: (i) => (i.severity ? <SeverityBadge severity={i.severity} size="sm" /> : <span className="rnv-muted">—</span>),
        filter: { type: "select", options: ["Critical", "Important", "Moderate", "Low"].map((v) => ({ value: v, label: v })) },
      },
      { id: "approval", header: "Approval", value: (i) => i.decision ?? "", width: 140, cell: (i) => <DecisionPill decision={i.decision ?? ""} size="sm" /> },
      {
        id: "rollout",
        header: "Rollout",
        value: (i) => i.attempt_state ?? "",
        width: 160,
        cell: (i) => (
          <>
            {i.attempt_state || "—"}
            {(i.attempt_failures ?? 0) > 0 && (
              <span className="rnv-dt__cell-sub" style={{ color: "var(--rnv-danger-fg)" }}>
                {i.attempt_failures} failed attempt{i.attempt_failures === 1 ? "" : "s"}
              </span>
            )}
          </>
        ),
      },
    ],
    [],
  );

  if (q.isLoading) return <TableSkeleton rows={4} cols={5} />;
  if (q.error) return <Alert color="red" icon={<Icons.Danger size={18} aria-hidden />}>{errorMessage(q.error)}</Alert>;
  const d = q.data!;
  const p = d.policy;
  const managed = p && (p.wsus_configured || p.wufb_deferrals || p.no_auto_update || p.wu_service_disabled);

  return (
    <Stack>
      {managed && (
        <Alert color="yellow" icon={<Icons.Warning size={18} aria-hidden />} title="Windows updates on this device are managed by another policy">
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
            {PRODUCT_NAME} does not change these policies. Installs can be delayed or blocked until you change them (for example with Group Policy).
          </Text>
        </Alert>
      )}
      {d.reboot_required && (
        <Alert color="orange" icon={<Icons.Restart size={18} aria-hidden />} title="This device is waiting for a restart">
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
        <Alert color="red" icon={<Icons.Danger size={18} aria-hidden />} title="The last scan failed">
          {d.scan_error}
        </Alert>
      )}
      <DataTable<Item>
        id="device-windows-updates"
        label="Windows updates on this device"
        data={d.items}
        columns={columns}
        rowId={(i) => i.update_id}
        rowLabel={(i) => i.title}
        searchPlaceholder="Search updates or KB numbers"
        exportName="windows-updates"
        selectable={canAct}
        empty={
          <EmptyState
            icon={d.scanned_at ? <Icons.Success size={26} /> : <Icons.Clock size={26} />}
            title={d.scanned_at ? "Nothing is missing on this device" : "No scan reported yet"}
            description={d.scanned_at ? `Last scan ${dateTime(d.scanned_at)}.` : "This device has not reported a scan yet."}
          />
        }
        toolbar={
          <>
            <span className="rnv-muted" style={{ fontSize: "var(--rnv-text-sm)" }}>
              {d.scanned_at ? `Last scan ${dateTime(d.scanned_at)}` : "This device has not reported a scan yet."}
              {d.truncated ? " The list is cut off; the device has more updates than it reports." : ""}
            </span>
            {canAct && (
              <Button variant="default" onClick={() => scan.mutate()} loading={scan.isPending} leftSection={<Icons.NavAgentUpdates size={16} aria-hidden />}>
                Scan now
              </Button>
            )}
          </>
        }
        bulkActions={(rows, clear) => {
          const ready = installable(rows);
          return (
            <>
              <Button size="compact-sm" onClick={() => setInstallFor({ items: ready, clear })} disabled={ready.length === 0}>
                Install selected
              </Button>
              <Button size="compact-sm" variant="default" onClick={() => hide.mutate({ ids: rows.filter((i) => i.state !== "hidden").map((i) => i.update_id), hide: true, clear })} disabled={rows.every((i) => i.state === "hidden")}>
                Hide
              </Button>
              <Button size="compact-sm" variant="default" onClick={() => hide.mutate({ ids: rows.filter((i) => i.state === "hidden").map((i) => i.update_id), hide: false, clear })} disabled={!rows.some((i) => i.state === "hidden")}>
                Unhide
              </Button>
            </>
          );
        }}
      />
      {installFor && <InstallModal items={installFor.items} busy={install.isPending} onCancel={() => setInstallFor(null)} onConfirm={(restart) => install.mutate({ ids: installFor.items.map((i) => i.update_id), restart }, { onSuccess: () => (installFor.clear(), setInstallFor(null)) })} />}
      {restartOpen && <RestartModal busy={reboot.isPending} onCancel={() => setRestartOpen(false)} onConfirm={(m) => reboot.mutate(m, { onSuccess: () => setRestartOpen(false) })} />}
    </Stack>
  );
}

export function InstallModal({ items, busy, onCancel, onConfirm }: { items: Item[]; busy: boolean; onCancel: () => void; onConfirm: (r: RestartPolicy) => void }) {
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

export function RestartModal({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: (minutes: number) => void }) {
  const [minutes, setMinutes] = useState<number | string>(5);
  return (
    <Modal opened onClose={onCancel} title="Restart this device">
      <Stack>
        <Text size="sm">Signed-in users see a countdown first and can ask you to wait; an administrator on the device can abort it with <code>shutdown /a</code>.</Text>
        <NumberInput
          label="Countdown (minutes)"
          description="1 minute is the shortest: people on the computer see the warning first, and Windows restarts when the countdown ends."
          min={1}
          max={1440}
          allowDecimal={false}
          allowNegative={false}
          clampBehavior="strict"
          value={minutes}
          onChange={setMinutes}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button color="orange" loading={busy} onClick={() => onConfirm(Math.min(1440, Math.max(1, Math.round(Number(minutes)) || 1)))}>
            Restart
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

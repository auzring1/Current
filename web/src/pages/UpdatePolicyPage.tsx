import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Checkbox, Group, Loader, Modal, MultiSelect, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type Group as Grp, type RestartPolicy, type UpdateRing, type UpdateRule, type UpdateSettings, type WuPolicy } from "../api/client";
import { dateTime, hhmm, parseHHMM } from "../api/format";
import { useSession } from "../api/session";

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const classifications = ["Security Updates", "Critical Updates", "Definition Updates", "Drivers", "Feature Packs", "Service Packs", "Update Rollups", "Updates", "Upgrades", "Tools"];
const severities = ["Critical", "Important", "Moderate", "Low", "Unrated"];

const serviceOptions = [
  { value: "default", label: "Whatever each device is configured for (WSUS if set by policy)" },
  { value: "windows_update", label: "Windows Update (internet)" },
  { value: "microsoft_update", label: "Microsoft Update (Office and other Microsoft products too)" },
];

const restartLabel = (r?: RestartPolicy) => {
  if (!r || !r.allow || r.allow === "never") return "never";
  if (r.allow === "outside_active_hours") return `outside ${hhmm(r.active_start ?? 480)}–${hhmm(r.active_end ?? 1020)}`;
  return `by deadline (${r.deadline_hours ?? 24} h)`;
};

export function UpdatePolicyPage() {
  const { can } = useSession();
  const canEdit = can("updates:policy");
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Update policy</Title>
        <Anchor component={Link} to="/updates" size="sm">
          Back to Windows updates
        </Anchor>
      </Group>
      <Text size="sm" c="dimmed">
        Updates only move when you approve them (or a rule does). Rings decide <i>who</i> gets an approved update first, and a ring that fails its success threshold stops the rollout.
        {!canEdit && " You can look at this page; only administrators can change it."}
      </Text>
      <SourceCard canEdit={canEdit} />
      <RingsCard canEdit={canEdit} />
      <RulesCard canEdit={canEdit} />
      <HoldsCard canEdit={canEdit} />
      <ConflictsCard />
    </Stack>
  );
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Stack gap="xs" mt="md">
      <Group justify="space-between">
        <div>
          <Title order={4}>{title}</Title>
          {hint && (
            <Text size="xs" c="dimmed">
              {hint}
            </Text>
          )}
        </div>
        {action}
      </Group>
      {children}
    </Stack>
  );
}

// ----- source settings -----

function SourceCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["updates", "settings"], queryFn: () => api<UpdateSettings>("GET", "/update-settings") });
  const [service, setService] = useState<string>("default");
  const [drivers, setDrivers] = useState(false);
  useEffect(() => {
    if (q.data) (setService(q.data.service), setDrivers(!!q.data.include_drivers));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api("PUT", "/update-settings", { service, include_drivers: drivers }),
    onSuccess: () => (notifications.show({ color: "green", message: "Saved. Devices will rescan with the new settings." }), qc.invalidateQueries({ queryKey: ["updates", "settings"] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const dirty = !!q.data && (q.data.service !== service || !!q.data.include_drivers !== drivers);
  return (
    <Section title="Update source" hint="Where devices look for updates. Devices managed by WSUS or Windows Update for Business policies keep following that policy; see the conflicts below.">
      {q.isLoading ? (
        <Loader size="sm" />
      ) : (
        <Group align="flex-end">
          <Select label="Service" data={serviceOptions} value={service} onChange={(v) => setService(v ?? "default")} allowDeselect={false} disabled={!canEdit} w={480} />
          <Checkbox label="Include drivers" checked={drivers} onChange={(e) => setDrivers(e.currentTarget.checked)} disabled={!canEdit} mb={6} />
          {canEdit && (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>
              Save
            </Button>
          )}
        </Group>
      )}
    </Section>
  );
}

// ----- rings -----

function RingsCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const rings = useQuery({ queryKey: ["updates", "rings"], queryFn: () => api<{ items: UpdateRing[] }>("GET", "/update-rings") });
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api<{ items: Grp[] }>("GET", "/groups") });
  const [edit, setEdit] = useState<UpdateRing | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api("DELETE", `/update-rings/${id}`),
    onSuccess: () => (notifications.show({ color: "green", message: "Ring deleted." }), qc.invalidateQueries({ queryKey: ["updates", "rings"] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const items = rings.data?.items ?? [];
  const groupName = (id: string) => groups.data?.items.find((g) => g.id === id)?.name ?? id.slice(0, 8);
  return (
    <Section
      title="Rings"
      hint="Pilot first, then broader. A device belongs to the first ring (in order) that lists one of its groups. Devices in no ring are not updated automatically."
      action={
        canEdit && (
          <Button size="xs" onClick={() => setEdit("new")}>
            Add ring
          </Button>
        )
      }
    >
      {rings.isLoading && <Loader size="sm" />}
      {rings.error && <Alert color="red">{errorMessage(rings.error)}</Alert>}
      {rings.data && items.length === 0 && (
        <Alert color="blue" title="No rings yet">
          Without rings, approved updates are never installed automatically. Add a pilot ring (a small group) and a broad ring (everyone else).
        </Alert>
      )}
      {items.length > 0 && (
        <Table verticalSpacing="xs" fz="sm" aria-label="Update rings">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Name</Table.Th>
              <Table.Th>Groups</Table.Th>
              <Table.Th>Delay</Table.Th>
              <Table.Th>Soak</Table.Th>
              <Table.Th>Success needed</Table.Th>
              <Table.Th>Window</Table.Th>
              <Table.Th>Restart</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((r) => (
              <Table.Tr key={r.id} opacity={r.enabled === false ? 0.5 : 1}>
                <Table.Td>{r.ordinal}</Table.Td>
                <Table.Td>
                  {r.name}
                  {r.enabled === false && (
                    <Badge ml={6} size="xs" color="gray">
                      disabled
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>{(r.group_ids ?? []).map(groupName).join(", ") || "—"}</Table.Td>
                <Table.Td>{r.delay_days ?? 0} d</Table.Td>
                <Table.Td>{r.soak_hours ?? 0} h</Table.Td>
                <Table.Td>{r.success_threshold}%</Table.Td>
                <Table.Td>{r.window ? `${(r.window.days ?? []).map((d) => dayNames[d]).join(" ") || "daily"} ${hhmm(r.window.start_minute)} +${r.window.duration_minutes} min` : "any time"}</Table.Td>
                <Table.Td>{restartLabel(r.restart)}</Table.Td>
                <Table.Td>
                  {canEdit && r.id && (
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Button size="compact-xs" variant="default" onClick={() => setEdit(r)} aria-label={`Edit ring ${r.name}`}>
                        Edit
                      </Button>
                      <Button size="compact-xs" variant="default" color="red" onClick={() => window.confirm(`Delete ring "${r.name}"?`) && del.mutate(r.id!)} aria-label={`Delete ring ${r.name}`}>
                        Delete
                      </Button>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {edit && <RingModal ring={edit === "new" ? undefined : edit} nextOrdinal={Math.min(20, items.reduce((m, r) => Math.max(m, r.ordinal), 0) + 1)} groups={groups.data?.items ?? []} onClose={() => setEdit(null)} />}
    </Section>
  );
}

function RingModal({ ring, nextOrdinal, groups, onClose }: { ring?: UpdateRing; nextOrdinal: number; groups: Grp[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ring?.name ?? "");
  const [ordinal, setOrdinal] = useState<number | string>(ring?.ordinal ?? nextOrdinal);
  const [groupIDs, setGroupIDs] = useState<string[]>(ring?.group_ids ?? []);
  const [delay, setDelay] = useState<number | string>(ring?.delay_days ?? 0);
  const [soak, setSoak] = useState<number | string>(ring?.soak_hours ?? 24);
  const [threshold, setThreshold] = useState<number | string>(ring?.success_threshold ?? 90);
  const [useWindow, setUseWindow] = useState(!!ring?.window);
  const [days, setDays] = useState<string[]>((ring?.window?.days ?? []).map(String));
  const [start, setStart] = useState(hhmm(ring?.window?.start_minute ?? 22 * 60));
  const [mins, setMins] = useState<number | string>(ring?.window?.duration_minutes ?? 240);
  const [restart, setRestart] = useState<string>(ring?.restart?.allow ?? "never");
  const [activeStart, setActiveStart] = useState(hhmm(ring?.restart?.active_start ?? 8 * 60));
  const [activeEnd, setActiveEnd] = useState(hhmm(ring?.restart?.active_end ?? 17 * 60));
  const [notify, setNotify] = useState<number | string>(ring?.restart?.notify_minutes ?? 15);
  const [deadline, setDeadline] = useState<number | string>(ring?.restart?.deadline_hours ?? 24);
  const [enabled, setEnabled] = useState(ring?.enabled !== false);
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () => {
      const body: UpdateRing = {
        name: name.trim(),
        ordinal: Number(ordinal),
        group_ids: groupIDs,
        delay_days: Number(delay) || 0,
        soak_hours: Number(soak) || 0,
        success_threshold: Number(threshold),
        enabled,
        restart: restart === "never" ? { allow: "never" } : { allow: restart as "outside_active_hours" | "deadline", active_start: parseHHMM(activeStart), active_end: parseHHMM(activeEnd), notify_minutes: Number(notify) || 15, deadline_hours: Number(deadline) || 24 },
      };
      if (useWindow) body.window = { days: days.map(Number), start_minute: parseHHMM(start), duration_minutes: Number(mins) || 60 };
      return ring?.id ? api("PUT", `/update-rings/${ring.id}`, body) : api("POST", "/update-rings", body);
    },
    onSuccess: () => (notifications.show({ color: "green", message: "Ring saved." }), qc.invalidateQueries({ queryKey: ["updates"] }), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  const valid = name.trim() !== "" && Number(ordinal) >= 1 && Number(threshold) >= 1 && Number(threshold) <= 100;
  return (
    <Modal opened onClose={onClose} title={ring ? `Edit ring ${ring.name}` : "Add ring"} size="lg">
      <Stack>
        <Group grow align="flex-start">
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={200} data-autofocus />
          <NumberInput label="Order" description="1 goes first" min={1} max={20} value={ordinal} onChange={setOrdinal} />
        </Group>
        <MultiSelect label="Groups" description="Devices in any of these groups belong to this ring" data={groups.map((g) => ({ value: g.id, label: g.name }))} value={groupIDs} onChange={setGroupIDs} searchable />
        <Group grow align="flex-start">
          <NumberInput label="Delay (days)" description="After approval before this ring may install" min={0} max={365} value={delay} onChange={setDelay} />
          <NumberInput label="Soak (hours)" description="How long the next ring waits after this one started" min={0} max={2160} value={soak} onChange={setSoak} />
          <NumberInput label="Success needed (%)" description="Of reporting devices" min={1} max={100} value={threshold} onChange={setThreshold} />
        </Group>
        <Checkbox label="Only install inside a maintenance window (device-local time)" checked={useWindow} onChange={(e) => setUseWindow(e.currentTarget.checked)} />
        {useWindow && (
          <Group align="flex-end">
            <MultiSelect label="Days" data={dayNames.map((n, i) => ({ value: String(i), label: n }))} value={days} onChange={setDays} w={240} placeholder="Every day" />
            <TextInput label="Starts" value={start} onChange={(e) => setStart(e.currentTarget.value)} w={90} aria-label="Window start" />
            <NumberInput label="Minutes" min={1} max={1440} value={mins} onChange={setMins} w={110} />
          </Group>
        )}
        <Select
          label="Restart after installing"
          data={[
            { value: "never", label: "Never restart automatically" },
            { value: "outside_active_hours", label: "Outside active hours, with a countdown users can see" },
            { value: "deadline", label: "At the latest this long after the install, with a countdown" },
          ]}
          value={restart}
          onChange={(v) => setRestart(v ?? "never")}
          allowDeselect={false}
        />
        {restart !== "never" && (
          <Group align="flex-end">
            <TextInput label="Active hours from" value={activeStart} onChange={(e) => setActiveStart(e.currentTarget.value)} w={110} />
            <TextInput label="to" value={activeEnd} onChange={(e) => setActiveEnd(e.currentTarget.value)} w={90} />
            <NumberInput label="Countdown (minutes)" min={1} max={1440} value={notify} onChange={setNotify} w={150} />
            {restart === "deadline" && <NumberInput label="Deadline (hours)" min={1} max={720} value={deadline} onChange={setDeadline} w={140} />}
          </Group>
        )}
        <Checkbox label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => (setError(""), save.mutate())} loading={save.isPending} disabled={!valid}>
            Save ring
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ----- rules -----

function RulesCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["updates", "rules"], queryFn: () => api<{ items: UpdateRule[] }>("GET", "/update-rules") });
  const [edit, setEdit] = useState<UpdateRule | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api("DELETE", `/update-rules/${id}`),
    onSuccess: () => (notifications.show({ color: "green", message: "Rule deleted." }), qc.invalidateQueries({ queryKey: ["updates", "rules"] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const items = rules.data?.items ?? [];
  return (
    <Section
      title="Auto-approval rules"
      hint="An update that matches an enabled rule is approved automatically once it is old enough. A decision you make by hand always wins over a rule."
      action={
        canEdit && (
          <Button size="xs" onClick={() => setEdit("new")}>
            Add rule
          </Button>
        )
      }
    >
      {rules.isLoading && <Loader size="sm" />}
      {rules.error && <Alert color="red">{errorMessage(rules.error)}</Alert>}
      {rules.data && items.length === 0 && <Text size="sm">No rules. Every update waits for you to approve it.</Text>}
      {items.length > 0 && (
        <Table verticalSpacing="xs" fz="sm" aria-label="Auto-approval rules">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Classifications</Table.Th>
              <Table.Th>Severities</Table.Th>
              <Table.Th>Drivers</Table.Th>
              <Table.Th>Wait</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((r) => (
              <Table.Tr key={r.id} opacity={r.enabled === false ? 0.5 : 1}>
                <Table.Td>
                  {r.name}
                  {r.enabled === false && (
                    <Badge ml={6} size="xs" color="gray">
                      disabled
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>{(r.classifications ?? []).join(", ") || "any"}</Table.Td>
                <Table.Td>{(r.severities ?? []).join(", ") || "any"}</Table.Td>
                <Table.Td>{r.include_drivers ? "yes" : "no"}</Table.Td>
                <Table.Td>{r.delay_days ?? 0} d after release</Table.Td>
                <Table.Td>
                  {canEdit && r.id && (
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Button size="compact-xs" variant="default" onClick={() => setEdit(r)} aria-label={`Edit rule ${r.name}`}>
                        Edit
                      </Button>
                      <Button size="compact-xs" variant="default" onClick={() => window.confirm(`Delete rule "${r.name}"? Approvals it already made stay.`) && del.mutate(r.id!)} aria-label={`Delete rule ${r.name}`}>
                        Delete
                      </Button>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {edit && <RuleModal rule={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </Section>
  );
}

function RuleModal({ rule, onClose }: { rule?: UpdateRule; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(rule?.name ?? "");
  const [cls, setCls] = useState<string[]>(rule?.classifications ?? []);
  const [sev, setSev] = useState<string[]>(rule?.severities ?? []);
  const [drivers, setDrivers] = useState(!!rule?.include_drivers);
  const [delay, setDelay] = useState<number | string>(rule?.delay_days ?? 0);
  const [enabled, setEnabled] = useState(rule?.enabled !== false);
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => {
      const body: UpdateRule = { name: name.trim(), classifications: cls, severities: sev as UpdateRule["severities"], include_drivers: drivers, delay_days: Number(delay) || 0, enabled };
      return rule?.id ? api("PUT", `/update-rules/${rule.id}`, body) : api("POST", "/update-rules", body);
    },
    onSuccess: () => (notifications.show({ color: "green", message: "Rule saved." }), qc.invalidateQueries({ queryKey: ["updates"] }), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal opened onClose={onClose} title={rule ? `Edit rule ${rule.name}` : "Add rule"}>
      <Stack>
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={200} data-autofocus />
        <MultiSelect label="Classifications" description="Empty = any" data={classifications} value={cls} onChange={setCls} />
        <MultiSelect label="Severities" description="Empty = any" data={severities} value={sev} onChange={setSev} />
        <Checkbox label="Also approve drivers" checked={drivers} onChange={(e) => setDrivers(e.currentTarget.checked)} />
        <NumberInput label="Wait (days after release)" min={0} max={365} value={delay} onChange={setDelay} />
        <Checkbox label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => (setError(""), save.mutate())} loading={save.isPending} disabled={name.trim() === ""}>
            Save rule
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ----- holds and conflicts -----

type Hold = { id: string; update_id: string; title?: string; ring_name: string; reason: string; created_at: string };

function HoldsCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const holds = useQuery({ queryKey: ["updates", "holds"], queryFn: () => api<{ items: Hold[] }>("GET", "/update-holds"), refetchInterval: 30_000 });
  const release = useMutation({
    mutationFn: (id: string) => api("POST", `/update-holds/${id}/release`, {}),
    onSuccess: () => (notifications.show({ color: "green", message: "Released. The update will continue to the next ring." }), qc.invalidateQueries({ queryKey: ["updates"] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const items = holds.data?.items ?? [];
  if (holds.isLoading || items.length === 0) return null;
  return (
    <Section title="Held updates" hint="These updates failed a ring's success threshold, so later rings are not getting them. Look at the failures, then release the hold or decline the update.">
      <Table verticalSpacing="xs" fz="sm" aria-label="Held updates">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Update</Table.Th>
            <Table.Th>Ring</Table.Th>
            <Table.Th>Reason</Table.Th>
            <Table.Th>Since</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((h) => (
            <Table.Tr key={h.id}>
              <Table.Td>{h.title || h.update_id}</Table.Td>
              <Table.Td>{h.ring_name}</Table.Td>
              <Table.Td>{h.reason}</Table.Td>
              <Table.Td>{dateTime(h.created_at)}</Table.Td>
              <Table.Td>
                {canEdit && (
                  <Button size="compact-xs" variant="default" onClick={() => window.confirm("Release this hold? The update will continue to later rings despite the failures.") && release.mutate(h.id)} aria-label={`Release hold ${h.title ?? h.update_id}`}>
                    Release
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Section>
  );
}

type Conflict = { device_id: string; hostname: string; policy?: WuPolicy };

function ConflictsCard() {
  const q = useQuery({ queryKey: ["updates", "conflicts"], queryFn: () => api<{ items: Conflict[] }>("GET", "/update-conflicts") });
  const items = q.data?.items ?? [];
  if (q.isLoading || items.length === 0) return null;
  return (
    <Section title="Devices managed by another update policy" hint="WSUS, deferral policies or disabled automatic updates on these devices can delay or block what Auzring installs.">
      <Table verticalSpacing="xs" fz="sm" aria-label="Policy conflicts">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Device</Table.Th>
            <Table.Th>Effective source</Table.Th>
            <Table.Th>Notes</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {items.map((c) => (
            <Table.Tr key={c.device_id}>
              <Table.Td>
                <Anchor component={Link} to={`/devices/${c.device_id}`}>
                  {c.hostname}
                </Anchor>
              </Table.Td>
              <Table.Td>{c.policy?.effective_source || "—"}</Table.Td>
              <Table.Td>{(c.policy?.notes ?? []).join("; ") || "—"}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Section>
  );
}

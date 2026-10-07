import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Anchor, Badge, Button, Checkbox, Group, Loader, Menu, Modal, Stack, Table, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Link } from "react-router-dom";
import {
  api,
  errorMessage,
  type AvailableUpdate,
  type DeploymentPlan,
  type DeviceSoftware,
  type DeviceUser,
  type SoftwareChange,
} from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";

const rowKey = (s: { source: string; scope: string; user_sid?: string; item_key?: string }) => `${s.source}|${s.scope}|${s.user_sid ?? ""}|${s.item_key ?? ""}`;
const ref = (s: { source: string; scope: string; user_sid?: string; item_key?: string }) => ({ source: s.source, scope: s.scope, user_sid: s.user_sid ?? "", item_key: s.item_key ?? "" });

function useUpdates(id: string) {
  const { can } = useSession();
  return useQuery({
    queryKey: ["device", id, "updates"],
    queryFn: () => api<{ items: AvailableUpdate[] }>("GET", `/devices/${id}/updates`),
    enabled: can("deployments:read"),
  });
}

/** Queues "update" deployments (one per package and scope) for the chosen updates on this device. */
function useDeployUpdates(deviceId: string, hostname: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ items, confirm }: { items: AvailableUpdate[]; confirm: boolean }) => {
      const groups = new Map<string, AvailableUpdate>();
      for (const u of items) groups.set(`${u.package_id}|${u.scope}`, u);
      const results: { name: string; plan?: DeploymentPlan; error?: string }[] = [];
      for (const u of groups.values()) {
        try {
          const plan = await api<DeploymentPlan>("POST", "/deployments", {
            name: `Update ${u.package_name} on ${hostname}`,
            action: "update",
            package_id: u.package_id,
            scope: u.scope,
            device_ids: [deviceId],
            unverified_confirmed: confirm,
          });
          results.push({ name: u.package_name, plan });
        } catch (e) {
          results.push({ name: u.package_name, error: errorMessage(e) });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      for (const r of results) {
        if (r.error) notifications.show({ color: "red", title: r.name, message: r.error, autoClose: 10000 });
        else notifications.show({ color: "green", message: `${r.name}: update queued (${r.plan?.jobs ?? 0} job${r.plan?.jobs === 1 ? "" : "s"}). Follow it on the Jobs tab.` });
      }
      void qc.invalidateQueries({ queryKey: ["device-jobs", deviceId] });
      void qc.invalidateQueries({ queryKey: ["deployments"] });
    },
  });
}

function UpdateConfirm({ items, onCancel, onConfirm, busy }: { items: AvailableUpdate[]; onCancel: () => void; onConfirm: (confirmed: boolean) => void; busy: boolean }) {
  const unverified = items.filter((u) => !u.verified);
  const [ok, setOk] = useState(false);
  return (
    <Modal opened onClose={onCancel} title={`Deploy ${items.length} update${items.length === 1 ? "" : "s"}`}>
      <Stack>
        <Table verticalSpacing={2} fz="sm" aria-label="Updates to deploy">
          <Table.Tbody>
            {items.map((u) => (
              <Table.Tr key={rowKey(u)}>
                <Table.Td>{u.name}</Table.Td>
                <Table.Td ff="monospace">
                  {u.installed_version} → {u.latest_version}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="sm" c="dimmed">
          Older copies the new installer does not replace by itself are removed first. Each update becomes a signed job on this device.
        </Text>
        {unverified.length > 0 && (
          <Alert color="yellow" title="Unverified packages">
            <Checkbox
              label={`${unverified.map((u) => u.package_name).join(", ")} ${unverified.length === 1 ? "has" : "have"} not been tested by Auzring. I accept deploying ${unverified.length === 1 ? "it" : "them"}; this is recorded in the audit log.`}
              checked={ok}
              onChange={(e) => setOk(e.currentTarget.checked)}
            />
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(ok)} loading={busy} disabled={unverified.length > 0 && !ok}>
            Deploy
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function UninstallConfirm({ rows, hostname, onCancel, onConfirm, busy }: { rows: DeviceSoftware[]; hostname: string; onCancel: () => void; onConfirm: () => void; busy: boolean }) {
  return (
    <Modal opened onClose={onCancel} title={`Uninstall ${rows.length} program${rows.length === 1 ? "" : "s"} from ${hostname}?`}>
      <Stack>
        <Table verticalSpacing={2} fz="sm" aria-label="Programs to uninstall">
          <Table.Tbody>
            {rows.map((s) => (
              <Table.Tr key={rowKey(s)}>
                <Table.Td>{s.name}</Table.Td>
                <Table.Td ff="monospace">{s.version || "—"}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Text size="sm" c="dimmed">
          The device removes each program with its own uninstaller, silently. Programs that offer no silent uninstaller fail with an explanation. Per-user programs are removed in that user's session.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button color="red" onClick={onConfirm} loading={busy}>
            Uninstall
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function SoftwareTab({ id, hostname, active }: { id: string; hostname: string; active: boolean }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [system, setSystem] = useState(false);
  const [filter, setFilter] = useState("");
  const [history, setHistory] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmUninstall, setConfirmUninstall] = useState<DeviceSoftware[] | null>(null);
  const [confirmUpdate, setConfirmUpdate] = useState<AvailableUpdate[] | null>(null);
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
  const updates = useUpdates(id);
  const updateByRow = useMemo(() => new Map((updates.data?.items ?? []).map((u) => [rowKey(u), u])), [updates.data]);
  const deploy = useDeployUpdates(id, hostname);
  const uninstall = useMutation({
    mutationFn: (rows: DeviceSoftware[]) =>
      api<{ job_ids: string[]; skipped: { device: string; reason: string }[] }>("POST", `/devices/${id}/software/uninstall`, { items: rows.map(ref) }),
    onSuccess: (r) => {
      if (r.job_ids.length) notifications.show({ color: "green", message: `Uninstall queued for ${r.job_ids.length} program${r.job_ids.length === 1 ? "" : "s"}. Follow it on the Jobs tab.` });
      for (const s of r.skipped) notifications.show({ color: "yellow", title: s.device, message: s.reason, autoClose: 10000 });
      setConfirmUninstall(null);
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ["device-jobs", id] });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });

  const who = (sid: string) => {
    if (!sid) return "all users";
    const u = users.data?.items.find((x) => x.sid === sid);
    return u ? (u.domain ? `${u.domain}\\${u.username}` : u.username) : sid;
  };
  const f = filter.trim().toLowerCase();
  const rows = (q.data?.items ?? []).filter((s) => !f || s.name.toLowerCase().includes(f) || (s.publisher ?? "").toLowerCase().includes(f));
  const canAct = active && can("deployments:write");
  const chosen = rows.filter((s) => selected.has(rowKey(s)));
  const chosenUpdates = chosen.map((s) => updateByRow.get(rowKey(s))).filter((u): u is AvailableUpdate => !!u && u.deployable);
  const allSelected = rows.length > 0 && rows.every((s) => selected.has(rowKey(s)));
  const toggle = (k: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

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
      {canAct && (
        <Group>
          <Button disabled={chosenUpdates.length === 0} onClick={() => setConfirmUpdate(chosenUpdates)}>
            Deploy Updates
          </Button>
          <Button color="red" variant="light" disabled={chosen.length === 0} onClick={() => setConfirmUninstall(chosen)}>
            Uninstall Software
          </Button>
          <Text size="sm" c="dimmed">
            {chosen.length} item{chosen.length === 1 ? "" : "s"} selected
          </Text>
        </Group>
      )}
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && rows.length === 0 && <Text c="dimmed">No software reported yet.</Text>}
      {rows.length > 0 && (
        <Table.ScrollContainer minWidth={820}>
          <Table aria-label="Installed software" verticalSpacing={4} fz="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                {canAct && (
                  <Table.Th w={36}>
                    <Checkbox
                      aria-label="Select all"
                      checked={allSelected}
                      indeterminate={!allSelected && chosen.length > 0}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map(rowKey)))}
                    />
                  </Table.Th>
                )}
                <Table.Th>Name</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Publisher</Table.Th>
                <Table.Th>Installed for</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Update status</Table.Th>
                <Table.Th>Installed</Table.Th>
                {canAct && <Table.Th ta="right">Actions</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((s) => {
                const k = rowKey(s);
                const u = updateByRow.get(k);
                return (
                  <Table.Tr key={k} data-testid="software-row" bg={selected.has(k) ? "var(--mantine-primary-color-light)" : undefined}>
                    {canAct && (
                      <Table.Td>
                        <Checkbox aria-label={`Select ${s.name}`} checked={selected.has(k)} onChange={() => toggle(k)} />
                      </Table.Td>
                    )}
                    <Table.Td>{s.name}</Table.Td>
                    <Table.Td ff="monospace">{s.version || "—"}</Table.Td>
                    <Table.Td>{s.publisher || "—"}</Table.Td>
                    <Table.Td>{who(s.user_sid ?? "")}</Table.Td>
                    <Table.Td>
                      <Badge variant="light" color="gray" size="sm">
                        {s.source}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {u ? (
                        <Tooltip label={u.deployable ? `${u.package_name} ${u.latest_version} is in the catalog` : (u.reason ?? "")}>
                          <Badge variant="light" color={u.deployable ? "orange" : "gray"} size="sm">
                            {u.deployable ? `update to ${u.latest_version}` : "vendor updates"}
                          </Badge>
                        </Tooltip>
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{s.install_date || dateTime(s.first_seen_at)}</Table.Td>
                    {canAct && (
                      <Table.Td ta="right">
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <Button size="compact-xs" variant="subtle" aria-label={`Actions for ${s.name}`}>
                              ⋮
                            </Button>
                          </Menu.Target>
                          <Menu.Dropdown>
                            {u?.deployable && <Menu.Item onClick={() => setConfirmUpdate([u])}>Deploy update to {u.latest_version}</Menu.Item>}
                            <Menu.Item color="red" onClick={() => setConfirmUninstall([s])}>
                              Uninstall Software
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    )}
                  </Table.Tr>
                );
              })}
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
      {confirmUninstall && <UninstallConfirm rows={confirmUninstall} hostname={hostname} onCancel={() => setConfirmUninstall(null)} onConfirm={() => uninstall.mutate(confirmUninstall)} busy={uninstall.isPending} />}
      {confirmUpdate && (
        <UpdateConfirm
          items={confirmUpdate}
          onCancel={() => setConfirmUpdate(null)}
          busy={deploy.isPending}
          onConfirm={(c) => deploy.mutate({ items: confirmUpdate, confirm: c }, { onSettled: () => (setConfirmUpdate(null), setSelected(new Set())) })}
        />
      )}
    </Stack>
  );
}

export function MissingUpdatesTab({ id, hostname, active }: { id: string; hostname: string; active: boolean }) {
  const { can } = useSession();
  const q = useUpdates(id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<AvailableUpdate[] | null>(null);
  const [filter, setFilter] = useState("");
  const deploy = useDeployUpdates(id, hostname);
  const f = filter.trim().toLowerCase();
  const rows = (q.data?.items ?? []).filter((u) => !f || u.name.toLowerCase().includes(f) || u.package_name.toLowerCase().includes(f));
  const canAct = active && can("deployments:write");
  const chosen = rows.filter((u) => selected.has(rowKey(u)) && u.deployable);
  const deployable = rows.filter((u) => u.deployable);
  const allSelected = deployable.length > 0 && deployable.every((u) => selected.has(rowKey(u)));
  const toggle = (k: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <Stack>
      <Group justify="space-between">
        <TextInput placeholder="Search" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} w={280} aria-label="Search updates" />
        <Text size="sm" c="dimmed">
          Updates come from packages you imported in the <Anchor component={Link} to="/catalog">Catalog</Anchor>.
        </Text>
      </Group>
      {canAct && (
        <Group>
          <Button disabled={chosen.length === 0} onClick={() => setConfirm(chosen)}>
            Deploy Updates
          </Button>
          <Text size="sm" c="dimmed">
            {chosen.length} update{chosen.length === 1 ? "" : "s"} selected
          </Text>
        </Group>
      )}
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && rows.length === 0 && <Alert color="green">No missing updates: every installed program that is in your catalog is at its newest allowed version.</Alert>}
      {rows.length > 0 && (
        <Table.ScrollContainer minWidth={760}>
          <Table aria-label="Missing updates" verticalSpacing={4} fz="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                {canAct && (
                  <Table.Th w={36}>
                    <Checkbox aria-label="Select all updates" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(deployable.map(rowKey)))} />
                  </Table.Th>
                )}
                <Table.Th>Name</Table.Th>
                <Table.Th>Installed version</Table.Th>
                <Table.Th>Latest version</Table.Th>
                <Table.Th>Package</Table.Th>
                <Table.Th>Status</Table.Th>
                {canAct && <Table.Th ta="right">Actions</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((u) => {
                const k = rowKey(u);
                return (
                  <Table.Tr key={k} data-testid="update-row">
                    {canAct && (
                      <Table.Td>
                        <Checkbox aria-label={`Select ${u.name}`} checked={selected.has(k)} disabled={!u.deployable} onChange={() => toggle(k)} />
                      </Table.Td>
                    )}
                    <Table.Td>{u.name}</Table.Td>
                    <Table.Td ff="monospace">{u.installed_version}</Table.Td>
                    <Table.Td ff="monospace">{u.latest_version}</Table.Td>
                    <Table.Td>
                      <Anchor component={Link} to={`/catalog/${u.package_id}`} size="sm">
                        {u.package_name}
                      </Anchor>
                      {!u.verified && (
                        <Badge ml={6} size="xs" variant="light" color="yellow">
                          unverified
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {u.deployable ? (
                        <Badge variant="light" color="orange">
                          update available
                        </Badge>
                      ) : (
                        <Tooltip label={u.reason}>
                          <Badge variant="light" color="gray">
                            vendor updates
                          </Badge>
                        </Tooltip>
                      )}
                    </Table.Td>
                    {canAct && (
                      <Table.Td ta="right">
                        <Menu position="bottom-end" withinPortal>
                          <Menu.Target>
                            <Button size="compact-xs" variant="subtle" aria-label={`Actions for ${u.name}`}>
                              ⋮
                            </Button>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item disabled={!u.deployable} onClick={() => setConfirm([u])}>
                              Deploy update to {u.latest_version}
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    )}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {confirm && (
        <UpdateConfirm
          items={confirm}
          onCancel={() => setConfirm(null)}
          busy={deploy.isPending}
          onConfirm={(c) => deploy.mutate({ items: confirm, confirm: c }, { onSettled: () => (setConfirm(null), setSelected(new Set())) })}
        />
      )}
    </Stack>
  );
}

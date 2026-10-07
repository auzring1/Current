import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Checkbox, Group, Loader, Modal, MultiSelect, NumberInput, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type Group as Grp, type Pkg, type SoftwarePolicy } from "../api/client";
import { useSession } from "../api/session";

const kindLabel: Record<string, string> = { keep_updated: "Keep updated", baseline: "Install on new devices" };

export function PoliciesPage() {
  const { canOrg } = useSession();
  const canWrite = canOrg("policies:write");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["policies"], queryFn: () => api<{ items: SoftwarePolicy[] }>("GET", "/policies") });
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api<{ items: Grp[] }>("GET", "/groups") });
  const [edit, setEdit] = useState<SoftwarePolicy | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api("DELETE", `/policies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["policies"] }),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const groupName = (id: string) => groups.data?.items.find((g) => g.id === id)?.name ?? id.slice(0, 8);
  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Software policies</Title>
        {canWrite && <Button onClick={() => setEdit("new")}>Add policy</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        A policy keeps a package current on a group (after a delay you choose), or installs it on devices that newly join a group. Each run creates an ordinary deployment you can follow under Deployments; a device that fails three times is left alone.
      </Text>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && q.data.items.length === 0 && <Alert color="blue">No policies yet.</Alert>}
      {q.data && q.data.items.length > 0 && (
        <Table verticalSpacing="xs" fz="sm" aria-label="Software policies">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>What</Table.Th>
              <Table.Th>Package</Table.Th>
              <Table.Th>Groups</Table.Th>
              <Table.Th>Delay</Table.Th>
              <Table.Th>Devices handled</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.items.map((p) => (
              <Table.Tr key={p.id} opacity={p.enabled ? 1 : 0.5}>
                <Table.Td>
                  {p.name}
                  {!p.enabled && (
                    <Badge ml={6} size="xs" color="gray">
                      disabled
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>{kindLabel[p.kind] ?? p.kind}</Table.Td>
                <Table.Td>{p.package_name}</Table.Td>
                <Table.Td>{p.group_ids.map(groupName).join(", ")}</Table.Td>
                <Table.Td>{p.delay_days} d</Table.Td>
                <Table.Td>{p.devices_attempted}</Table.Td>
                <Table.Td>
                  {canWrite && (
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Button size="compact-xs" variant="default" onClick={() => setEdit(p)} aria-label={`Edit policy ${p.name}`}>
                        Edit
                      </Button>
                      <Button size="compact-xs" variant="default" color="red" onClick={() => window.confirm(`Delete policy "${p.name}"?`) && del.mutate(p.id)} aria-label={`Delete policy ${p.name}`}>
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
      {edit && <PolicyModal policy={edit === "new" ? undefined : edit} groups={groups.data?.items ?? []} onClose={() => setEdit(null)} />}
    </>
  );
}

function PolicyModal({ policy, groups, onClose }: { policy?: SoftwarePolicy; groups: Grp[]; onClose: () => void }) {
  const qc = useQueryClient();
  const pkgs = useQuery({ queryKey: ["catalog", "packages", ""], queryFn: () => api<{ items: Pkg[] }>("GET", "/catalog/packages?limit=500") });
  const [name, setName] = useState(policy?.name ?? "");
  const [kind, setKind] = useState<string>(policy?.kind ?? "keep_updated");
  const [pkg, setPkg] = useState<string | null>(policy?.package_id ?? null);
  const [gs, setGs] = useState<string[]>(policy?.group_ids ?? []);
  const [delay, setDelay] = useState<number | string>(policy?.delay_days ?? 0);
  const [onlyNew, setOnlyNew] = useState(policy?.only_new_devices ?? true);
  const [unverified, setUnverified] = useState(policy?.unverified_confirmed ?? false);
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [error, setError] = useState("");
  const chosen = pkgs.data?.items.find((p) => p.id === pkg);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), kind, package_id: pkg, group_ids: gs, delay_days: Number(delay) || 0, only_new_devices: onlyNew, unverified_confirmed: unverified, enabled };
      return policy ? api("PUT", `/policies/${policy.id}`, body) : api("POST", "/policies", body);
    },
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ["policies"] }), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal opened onClose={onClose} title={policy ? `Edit ${policy.name}` : "Add policy"} size="lg">
      <form onSubmit={(e) => (e.preventDefault(), setError(""), save.mutate())}>
        <Stack>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required maxLength={200} data-autofocus />
          <Select
            label="What it does"
            data={[
              { value: "keep_updated", label: "Keep the package at its newest version where it is installed" },
              { value: "baseline", label: "Install the package on devices that newly join the groups" },
            ]}
            value={kind}
            onChange={(v) => setKind(v ?? "keep_updated")}
            allowDeselect={false}
          />
          <Select label="Package" data={(pkgs.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))} value={pkg} onChange={setPkg} searchable required placeholder="Pick a package from the catalog" />
          <MultiSelect label="Groups" data={groups.map((g) => ({ value: g.id, label: g.name }))} value={gs} onChange={setGs} searchable required />
          <NumberInput label="Wait after a new version appears (days)" min={0} max={365} value={delay} onChange={setDelay} />
          {kind === "baseline" && <Checkbox label="Only devices enrolled after this policy was created" checked={onlyNew} onChange={(e) => setOnlyNew(e.currentTarget.checked)} />}
          {chosen && chosen.source === "winget" && !chosen.verified && (
            <Checkbox label="I accept that this winget package has not been verified on test machines" checked={unverified} onChange={(e) => setUnverified(e.currentTarget.checked)} />
          )}
          <Checkbox label="Enabled" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          {error && <Alert color="red">{error}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} disabled={!name.trim() || !pkg || gs.length === 0}>
              Save policy
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

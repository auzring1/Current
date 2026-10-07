import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, MultiSelect, SegmentedControl, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type Device, type Filter, type Group as Grp, type GroupMembers } from "../api/client";
import { FilterEditor, newGroup } from "../components/FilterEditor";
import { useSession } from "../api/session";

function Members({ data, onRemove }: { data: GroupMembers; onRemove?: (id: string) => void }) {
  return (
    <Table aria-label="Matching devices" verticalSpacing={4} fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Device</Table.Th>
          <Table.Th>Model</Table.Th>
          <Table.Th>OS</Table.Th>
          <Table.Th>Connection</Table.Th>
          {onRemove && <Table.Th />}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {data.items.map((m) => (
          <Table.Tr key={m.id}>
            <Table.Td>
              <Anchor component={Link} to={`/devices/${m.id}`} size="sm">
                {m.hostname}
              </Anchor>
            </Table.Td>
            <Table.Td>{[m.manufacturer, m.model].filter(Boolean).join(" ") || "—"}</Table.Td>
            <Table.Td>{m.os_caption || "—"}</Table.Td>
            <Table.Td>{m.online ? "online" : "offline"}</Table.Td>
            {onRemove && (
              <Table.Td ta="right">
                <Button size="compact-xs" variant="light" color="red" onClick={() => onRemove(m.id)}>
                  Remove
                </Button>
              </Table.Td>
            )}
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function GroupsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Grp | "new" | null>(null);
  const [viewing, setViewing] = useState<Grp | null>(null);
  const list = useQuery({ queryKey: ["groups"], queryFn: () => api<{ items: Grp[] }>("GET", "/groups") });
  const del = useMutation({
    mutationFn: (id: string) => api("DELETE", `/groups/${id}`),
    onSuccess: () => (notifications.show({ color: "green", message: "Group deleted." }), qc.invalidateQueries({ queryKey: ["groups"] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const changeMembers = useMutation({
    mutationFn: (b: { add?: string[]; remove?: string[] }) => api("POST", `/groups/${viewing!.id}/members`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["groups", "members"] }),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const members = useQuery({
    queryKey: ["groups", "members", viewing?.id],
    queryFn: () => api<GroupMembers>("GET", `/groups/${viewing!.id}/devices?limit=500`),
    enabled: !!viewing,
  });

  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Groups</Title>
        {can("groups:write") && (
          <Group>
            <Button onClick={() => setEditing("new")}>New group</Button>
          </Group>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Dynamic groups are saved filters: membership is recomputed every time you look, so a device joins or leaves as its software changes. Static groups are lists you maintain by hand.
      </Text>
      {list.isLoading && <Loader />}
      {list.error && <Alert color="red">{errorMessage(list.error)}</Alert>}
      {list.data && list.data.items.length === 0 && <Alert color="blue">No groups yet. Create one, for example “laptops with Chrome older than 130”.</Alert>}
      {!!list.data?.items.length && (
        <Table highlightOnHover verticalSpacing="xs" aria-label="Groups">
          <Table.Tbody>
            {list.data.items.map((g) => (
              <Table.Tr key={g.id} data-testid="group-row">
                <Table.Td>
                  <Anchor component="button" type="button" fw={500} onClick={() => setViewing(g)}>
                    {g.name}
                  </Anchor>{" "}
                  <Badge size="xs" variant="light" color={g.kind === "static" ? "grape" : "blue"}>
                    {g.kind}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {g.description}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">
                  <Group gap="xs" justify="flex-end">
                    {can("groups:write") && (
                      <>
                        <Button size="xs" variant="default" onClick={() => setEditing(g)}>
                          Edit
                        </Button>
                        <Button size="xs" variant="light" color="red" onClick={() => window.confirm(`Delete group “${g.name}”?`) && del.mutate(g.id)}>
                          Delete
                        </Button>
                      </>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal opened={!!viewing} onClose={() => setViewing(null)} title={viewing?.name} size="xl">
        <Stack>
          {members.isLoading && <Loader />}
          {members.error && <Alert color="red">{errorMessage(members.error)}</Alert>}
          {members.data && (
            <>
              <Group justify="space-between">
                <Badge size="lg" variant="light">
                  {members.data.total} device{members.data.total === 1 ? "" : "s"}
                </Badge>
                {can("inventory:export") && viewing && (
                  <Button component="a" size="xs" variant="default" href={`/api/v1/reports/devices.csv?group_id=${viewing.id}`} download>
                    Export CSV
                  </Button>
                )}
              </Group>
              {viewing?.kind === "static" && can("groups:write") && <AddMembers existing={members.data.items.map((m) => m.id)} onAdd={(ids) => changeMembers.mutate({ add: ids })} />}
              {members.data.items.length > 0 && (
                <Members data={members.data} onRemove={viewing?.kind === "static" && can("groups:write") ? (id) => changeMembers.mutate({ remove: [id] }) : undefined} />
              )}
            </>
          )}
        </Stack>
      </Modal>

      {editing && <GroupEditor group={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function GroupEditor({ group, onClose }: { group: Grp | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [kind, setKind] = useState<"dynamic" | "static">(group?.kind ?? "dynamic");
  const [filter, setFilter] = useState<Filter>(group?.filter ?? newGroup());
  const [error, setError] = useState("");
  const preview = useMutation({
    mutationFn: () => api<GroupMembers>("POST", "/groups/preview?limit=50", { filter }),
    onMutate: () => setError(""),
    onError: (e) => setError(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: () => (group ? api("PUT", `/groups/${group.id}`, group.kind === "static" ? { name, description } : { name, description, filter }) : api("POST", "/groups", kind === "static" ? { kind, name, description } : { kind, name, description, filter })),
    onSuccess: () => (notifications.show({ color: "green", message: "Group saved." }), qc.invalidateQueries({ queryKey: ["groups"] }), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal opened onClose={onClose} title={group ? "Edit group" : "New group"} size="xl">
      <Stack>
        {!group && (
          <SegmentedControl
            value={kind}
            onChange={(v) => setKind(v as typeof kind)}
            data={[
              { value: "dynamic", label: "Dynamic (filter)" },
              { value: "static", label: "Static (hand-picked)" },
            ]}
          />
        )}
        <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={200} />
        <Textarea label="Description" value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={1000} autosize minRows={1} maxRows={3} />
        {kind === "dynamic" ? (
          <>
            <Text size="sm" fw={500}>
              Devices that match
            </Text>
            <FilterEditor node={filter} onChange={setFilter} />
          </>
        ) : (
          <Text size="sm" c="dimmed">
            Save the group, then open it to add devices.
          </Text>
        )}
        {error && <Alert color="red">{error}</Alert>}
        <Group>
          {kind === "dynamic" && (
            <Button variant="default" onClick={() => preview.mutate()} loading={preview.isPending}>
              Preview matches
            </Button>
          )}
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim()}>
            Save group
          </Button>
        </Group>
        {preview.data && (
          <Stack gap="xs">
            <Badge size="lg" variant="light" data-testid="preview-total">
              {preview.data.total} matching device{preview.data.total === 1 ? "" : "s"}
            </Badge>
            {preview.data.items.length > 0 && <Members data={preview.data} />}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

function AddMembers({ existing, onAdd }: { existing: string[]; onAdd: (ids: string[]) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const devices = useQuery({ queryKey: ["devices", "active"], queryFn: () => api<{ items: Device[] }>("GET", "/devices?status=active&limit=500") });
  const data = (devices.data?.items ?? []).filter((d) => !existing.includes(d.id)).map((d) => ({ value: d.id, label: d.hostname }));
  return (
    <Group align="flex-end">
      <MultiSelect label="Add devices" searchable data={data} value={sel} onChange={setSel} style={{ flex: 1 }} placeholder="Choose devices" />
      <Button onClick={() => (onAdd(sel), setSel([]))} disabled={!sel.length}>
        Add
      </Button>
    </Group>
  );
}

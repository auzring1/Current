import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type Filter, type Group as Grp, type GroupMembers } from "../api/client";
import { FilterEditor, newGroup } from "../components/FilterEditor";
import { useSession } from "../api/session";

function Members({ data }: { data: GroupMembers }) {
  return (
    <Table aria-label="Matching devices" verticalSpacing={4} fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Device</Table.Th>
          <Table.Th>Model</Table.Th>
          <Table.Th>OS</Table.Th>
          <Table.Th>Connection</Table.Th>
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
  const members = useQuery({
    queryKey: ["groups", "members", viewing?.id],
    queryFn: () => api<GroupMembers>("GET", `/groups/${viewing!.id}/devices?limit=500`),
    enabled: !!viewing,
  });

  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Groups</Title>
        {can("groups:write") && <Button onClick={() => setEditing("new")}>New group</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Dynamic groups are saved filters. Membership is recomputed every time you look, so a device joins or leaves as its software changes.
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
                  </Anchor>
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
              {members.data.items.length > 0 && <Members data={members.data} />}
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
  const [filter, setFilter] = useState<Filter>(group?.filter ?? newGroup());
  const [error, setError] = useState("");
  const preview = useMutation({
    mutationFn: () => api<GroupMembers>("POST", "/groups/preview?limit=50", { filter }),
    onMutate: () => setError(""),
    onError: (e) => setError(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: () => (group ? api("PUT", `/groups/${group.id}`, { name, description, filter }) : api("POST", "/groups", { name, description, filter })),
    onSuccess: () => (notifications.show({ color: "green", message: "Group saved." }), qc.invalidateQueries({ queryKey: ["groups"] }), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal opened onClose={onClose} title={group ? "Edit group" : "New group"} size="xl">
      <Stack>
        <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={200} />
        <Textarea label="Description" value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={1000} autosize minRows={1} maxRows={3} />
        <Text size="sm" fw={500}>
          Devices that match
        </Text>
        <FilterEditor node={filter} onChange={setFilter} />
        {error && <Alert color="red">{error}</Alert>}
        <Group>
          <Button variant="default" onClick={() => preview.mutate()} loading={preview.isPending}>
            Preview matches
          </Button>
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

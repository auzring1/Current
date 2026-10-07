import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Group, Loader, Modal, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type Site } from "../api/client";
import { useSession } from "../api/session";

export function SitesPage() {
  const { canOrg } = useSession();
  const canWrite = canOrg("sites:write");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sites"], queryFn: () => api<{ items: Site[] }>("GET", "/sites") });
  const [edit, setEdit] = useState<Site | "new" | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api("DELETE", `/sites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sites"] }),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Sites</Title>
        {canWrite && <Button onClick={() => setEdit("new")}>Add site</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        A site is a location or customer. New devices join the site named by the enrollment token they use. Give a person a role on a site and they manage that site's devices and nothing else.
      </Text>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <Table verticalSpacing="xs" fz="sm" aria-label="Sites">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Time zone</Table.Th>
              <Table.Th>Devices</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.items.map((s) => (
              <Table.Tr key={s.id}>
                <Table.Td>{s.name}</Table.Td>
                <Table.Td>{s.timezone}</Table.Td>
                <Table.Td>{s.devices}</Table.Td>
                <Table.Td>
                  {canWrite && (
                    <Group gap="xs" justify="flex-end">
                      <Button size="compact-xs" variant="default" onClick={() => setEdit(s)} aria-label={`Edit site ${s.name}`}>
                        Edit
                      </Button>
                      <Button size="compact-xs" variant="default" color="red" onClick={() => window.confirm(`Delete site "${s.name}"?`) && del.mutate(s.id)} aria-label={`Delete site ${s.name}`}>
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
      {edit && <SiteModal site={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function SiteModal({ site, onClose }: { site?: Site; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(site?.name ?? "");
  const [tz, setTz] = useState(site?.timezone ?? "UTC");
  const [error, setError] = useState("");
  const save = useMutation({
    mutationFn: () => (site ? api("PUT", `/sites/${site.id}`, { name: name.trim(), timezone: tz }) : api("POST", "/sites", { name: name.trim(), timezone: tz })),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ["sites"] }), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal opened onClose={onClose} title={site ? `Edit ${site.name}` : "Add site"}>
      <form onSubmit={(e) => (e.preventDefault(), setError(""), save.mutate())}>
        <Stack>
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required maxLength={200} data-autofocus />
          <TextInput label="Time zone" description="IANA name, for example Europe/Berlin" value={tz} onChange={(e) => setTz(e.currentTarget.value)} />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

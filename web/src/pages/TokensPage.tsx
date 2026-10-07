import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Group, Loader, Modal, NumberInput, Stack, Switch, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type EnrollmentToken } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";
import { CopyText, StatusBadge } from "../components/common";

interface Created {
  token: EnrollmentToken;
  enrollment_string: string;
  install_command: string;
  root_ca_pin: string;
}

export function TokensPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", max_uses: 10, expires_in_hours: 24, require_approval: false });
  const [created, setCreated] = useState<Created | null>(null);
  const q = useQuery({ queryKey: ["tokens"], queryFn: () => api<{ items: EnrollmentToken[] }>("GET", "/enrollment-tokens") });
  const create = useMutation({
    mutationFn: () => api<Created>("POST", "/enrollment-tokens", form),
    onSuccess: (c) => {
      setOpen(false);
      setCreated(c);
      void qc.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api("POST", `/enrollment-tokens/${id}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tokens"] }),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={2}>Enrollment tokens</Title>
        {can("enrollment:write") && <Button onClick={() => setOpen(true)}>New token</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Tokens let new devices enroll. Keep them short-lived and limited in uses. Turn on approval to review each device before it is trusted.
      </Text>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <Table.ScrollContainer minWidth={700}>
          <Table aria-label="Enrollment tokens">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>State</Table.Th>
                <Table.Th>Uses</Table.Th>
                <Table.Th>Approval</Table.Th>
                <Table.Th>Expires</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {q.data.items.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>{t.name}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={t.state} />
                  </Table.Td>
                  <Table.Td>
                    {t.used_count} / {t.max_uses}
                  </Table.Td>
                  <Table.Td>{t.require_approval ? "required" : "automatic"}</Table.Td>
                  <Table.Td>{dateTime(t.expires_at)}</Table.Td>
                  <Table.Td>
                    {can("enrollment:write") && t.state === "active" && (
                      <Button size="xs" variant="subtle" color="red" onClick={() => revoke.mutate(t.id)}>
                        Revoke
                      </Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <Modal opened={open} onClose={() => setOpen(false)} title="New enrollment token">
        <form onSubmit={(e) => (e.preventDefault(), create.mutate())}>
          <Stack>
            <TextInput label="Name" placeholder="e.g. Head office laptops" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required maxLength={200} />
            <NumberInput label="Maximum uses" min={1} max={100000} value={form.max_uses} onChange={(v) => setForm({ ...form, max_uses: Number(v) || 1 })} />
            <NumberInput label="Valid for (hours)" min={1} max={8760} value={form.expires_in_hours} onChange={(v) => setForm({ ...form, expires_in_hours: Number(v) || 1 })} />
            <Switch label="Require administrator approval for each device" checked={form.require_approval} onChange={(e) => setForm({ ...form, require_approval: e.currentTarget.checked })} />
            <Button type="submit" loading={create.isPending}>
              Create
            </Button>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!created} onClose={() => setCreated(null)} title="Token created" size="xl">
        {created && (
          <Stack>
            <Alert color="yellow">This is the only time the token is shown. Anyone with it can enroll devices until it expires or is used up.</Alert>
            <Text fw={500}>Install on a Windows device (elevated PowerShell or Command Prompt):</Text>
            <CopyText value={created.install_command} label="Copy install command" />
            <Text size="sm" c="dimmed">
              The agent verifies the server's certificate authority against this pin, carried inside the token: {created.root_ca_pin}
            </Text>
          </Stack>
        )}
      </Modal>
    </>
  );
}

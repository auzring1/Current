import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Group, Loader, Menu, Modal, Select, Stack, Table, Tabs, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type ApiToken, type Site, type UserAccount } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";
import { CopyText } from "../components/common";

const roleLabel: Record<string, string> = { admin: "Administrator", operator: "Operator", readonly: "Read-only" };

export function UsersPage() {
  const { session, canOrg } = useSession();
  const canWrite = canOrg("users:write");
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ items: UserAccount[] }>("GET", "/users") });
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api<{ items: Site[] }>("GET", "/sites") });
  const tokens = useQuery({ queryKey: ["all-api-tokens"], queryFn: () => api<{ items: ApiToken[] }>("GET", "/api-tokens") });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const siteName = (id: string) => sites.data?.items.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["users"] });
  const revokeToken = useMutation({
    mutationFn: (id: string) => api("DELETE", `/api-tokens/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["all-api-tokens"] }),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const act = useMutation({
    mutationFn: async (a: { u: UserAccount; kind: "disable" | "enable" | "reset-password" | "reset-mfa" | "delete" }) => {
      const { u, kind } = a;
      if (kind === "disable" || kind === "enable") return api("PUT", `/users/${u.id}`, { display_name: u.display_name, status: kind === "disable" ? "disabled" : "active" });
      if (kind === "reset-password") {
        const r = await api<{ temporary_password?: string }>("POST", `/users/${u.id}/reset-password`, {});
        if (r.temporary_password) setSecret({ email: u.email, password: r.temporary_password });
        return r;
      }
      if (kind === "reset-mfa") return api("POST", `/users/${u.id}/reset-mfa`, {});
      return api("DELETE", `/users/${u.id}`);
    },
    onSuccess: refresh,
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });

  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Users</Title>
        {canWrite && <Button onClick={() => setCreating(true)}>Add user</Button>}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Everyone signs in with a password and a second factor. A role can apply to the whole organization or to a single site; a site role lets someone manage the devices of that site from their pages and nothing else.
      </Text>
      <Tabs defaultValue="users">
        <Tabs.List>
          <Tabs.Tab value="users">Users</Tabs.Tab>
          <Tabs.Tab value="tokens">API tokens</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="users" pt="md">
          {users.isLoading && <Loader />}
          {users.error && <Alert color="red">{errorMessage(users.error)}</Alert>}
          {users.data && (
            <Table.ScrollContainer minWidth={820}>
              <Table verticalSpacing="xs" fz="sm" aria-label="Users">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>User</Table.Th>
                    <Table.Th>Roles</Table.Th>
                    <Table.Th>Second factor</Table.Th>
                    <Table.Th>Last sign-in</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {users.data.items.map((u) => (
                    <Table.Tr key={u.id} data-testid="user-row" opacity={u.status === "disabled" ? 0.55 : 1}>
                      <Table.Td>
                        <Text size="sm">{u.display_name}</Text>
                        <Text size="xs" c="dimmed">
                          {u.email}
                        </Text>
                        {u.status === "disabled" && (
                          <Badge size="xs" color="gray">
                            disabled
                          </Badge>
                        )}
                        {u.must_change_password && (
                          <Badge size="xs" color="yellow" ml={4}>
                            must change password
                          </Badge>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {u.bindings.map((b) => (
                          <div key={b.id}>
                            {roleLabel[b.role] ?? b.role}
                            <Text span c="dimmed" size="xs">
                              {" "}
                              — {b.scope_type === "org" ? "whole organization" : `site ${siteName(b.scope_id)}`}
                            </Text>
                          </div>
                        ))}
                      </Table.Td>
                      <Table.Td>
                        {u.has_totp ? "authenticator" : ""}
                        {u.has_totp && u.security_keys > 0 ? ", " : ""}
                        {u.security_keys > 0 ? `${u.security_keys} security key${u.security_keys === 1 ? "" : "s"}` : ""}
                        {!u.has_totp && u.security_keys === 0 ? "to be set up at next sign-in" : ""}
                      </Table.Td>
                      <Table.Td>{dateTime(u.last_login_at)}</Table.Td>
                      <Table.Td>
                        {canWrite && (
                          <Menu position="bottom-end">
                            <Menu.Target>
                              <Button size="compact-xs" variant="default" aria-label={`Actions for ${u.email}`}>
                                ⋮
                              </Button>
                            </Menu.Target>
                            <Menu.Dropdown>
                              <Menu.Item onClick={() => setEditing(u)}>Roles…</Menu.Item>
                              <Menu.Item onClick={() => act.mutate({ u, kind: "reset-password" })}>Set a temporary password</Menu.Item>
                              <Menu.Item onClick={() => window.confirm(`Remove all second factors of ${u.email}? They will set up a new one at the next sign-in.`) && act.mutate({ u, kind: "reset-mfa" })}>
                                Reset second factor
                              </Menu.Item>
                              {u.id !== session?.user.id && (
                                <>
                                  <Menu.Item onClick={() => act.mutate({ u, kind: u.status === "active" ? "disable" : "enable" })}>{u.status === "active" ? "Disable" : "Enable"}</Menu.Item>
                                  <Menu.Item color="red" onClick={() => window.confirm(`Delete ${u.email}? This cannot be undone.`) && act.mutate({ u, kind: "delete" })}>
                                    Delete
                                  </Menu.Item>
                                </>
                              )}
                            </Menu.Dropdown>
                          </Menu>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="tokens" pt="md">
          <Text size="sm" c="dimmed" mb="sm">
            Tokens created by anyone in the organization. A token can do no more than its owner and its scopes allow, and stops working when its owner is disabled.
          </Text>
          {tokens.data && tokens.data.items.length === 0 && <Text size="sm">No API tokens.</Text>}
          {tokens.data && tokens.data.items.length > 0 && (
            <Table verticalSpacing="xs" fz="sm" aria-label="API tokens of the organization">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Owner</Table.Th>
                  <Table.Th>Scopes</Table.Th>
                  <Table.Th>Expires</Table.Th>
                  <Table.Th>Last used</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {tokens.data.items.map((t) => (
                  <Table.Tr key={t.id} opacity={t.revoked_at ? 0.5 : 1}>
                    <Table.Td>
                      {t.name} <Text span c="dimmed" size="xs">{t.prefix}…</Text>
                    </Table.Td>
                    <Table.Td>{t.owner}</Table.Td>
                    <Table.Td>{t.scopes.join(", ")}</Table.Td>
                    <Table.Td>{t.revoked_at ? "revoked" : dateTime(t.expires_at)}</Table.Td>
                    <Table.Td>{dateTime(t.last_used_at)}</Table.Td>
                    <Table.Td>
                      {canWrite && !t.revoked_at && (
                        <Button size="compact-xs" variant="default" color="red" onClick={() => window.confirm(`Revoke the token "${t.name}"?`) && revokeToken.mutate(t.id)}>
                          Revoke
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Tabs.Panel>
      </Tabs>
      {creating && <CreateUserModal sites={sites.data?.items ?? []} orgId={session?.org.id ?? ""} onClose={() => setCreating(false)} onCreated={(email, pw) => (refresh(), pw && setSecret({ email, password: pw }))} />}
      {editing && <RolesModal user={users.data?.items.find((u) => u.id === editing.id) ?? editing} sites={sites.data?.items ?? []} orgId={session?.org.id ?? ""} onClose={() => setEditing(null)} />}
      <Modal opened={!!secret} onClose={() => setSecret(null)} title="Temporary password">
        {secret && (
          <Stack>
            <Alert color="yellow">Shown only once. Give it to {secret.email} privately; they must choose their own password at the first sign-in.</Alert>
            <CopyText value={secret.password} label="Copy password" />
          </Stack>
        )}
      </Modal>
    </>
  );
}

function scopeOptions(sites: Site[], orgId: string) {
  return [{ value: `org:${orgId}`, label: "Whole organization" }, ...sites.map((s) => ({ value: `site:${s.id}`, label: `Site: ${s.name}` }))];
}

function CreateUserModal({ sites, orgId, onClose, onCreated }: { sites: Site[]; orgId: string; onClose: () => void; onCreated: (email: string, password?: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<string | null>("operator");
  const [scope, setScope] = useState<string | null>(`org:${orgId}`);
  const [error, setError] = useState("");
  const create = useMutation({
    mutationFn: () => {
      const [scope_type, scope_id] = (scope ?? "").split(":");
      return api<{ temporary_password?: string }>("POST", "/users", { email: email.trim(), display_name: name.trim(), roles: [{ role, scope_type, scope_id }] });
    },
    onSuccess: (r) => (onCreated(email.trim(), r.temporary_password), onClose()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal opened onClose={onClose} title="Add user">
      <form onSubmit={(e) => (e.preventDefault(), setError(""), create.mutate())}>
        <Stack>
          <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} required data-autofocus />
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required maxLength={200} />
          <Select label="Role" data={Object.entries(roleLabel).map(([value, label]) => ({ value, label }))} value={role} onChange={setRole} allowDeselect={false} />
          <Select label="Applies to" data={scopeOptions(sites, orgId)} value={scope} onChange={setScope} allowDeselect={false} />
          <Text size="xs" c="dimmed">
            A temporary password is generated. The user must change it at the first sign-in and then set up a second factor.
          </Text>
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={create.isPending}>
            Create user
          </Button>
        </Stack>
      </form>
    </Modal>
  );
}

function RolesModal({ user, sites, orgId, onClose }: { user: UserAccount; sites: Site[]; orgId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [role, setRole] = useState<string | null>("operator");
  const [scope, setScope] = useState<string | null>(`org:${orgId}`);
  const [error, setError] = useState("");
  const done = () => void qc.invalidateQueries({ queryKey: ["users"] });
  const add = useMutation({
    mutationFn: () => {
      const [scope_type, scope_id] = (scope ?? "").split(":");
      return api("POST", `/users/${user.id}/roles`, { role, scope_type, scope_id });
    },
    onSuccess: () => (setError(""), done()),
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (bid: string) => api("DELETE", `/users/${user.id}/roles/${bid}`),
    onSuccess: () => (setError(""), done()),
    onError: (e) => setError(errorMessage(e)),
  });
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  return (
    <Modal opened onClose={onClose} title={`Roles of ${user.display_name}`}>
      <Stack>
        {user.bindings.map((b) => (
          <Group key={b.id} justify="space-between">
            <Text size="sm">
              {roleLabel[b.role] ?? b.role} — {b.scope_type === "org" ? "whole organization" : `site ${siteName(b.scope_id)}`}
            </Text>
            <Button size="compact-xs" variant="default" color="red" onClick={() => remove.mutate(b.id)} aria-label={`Remove ${b.role} ${b.scope_type}`}>
              Remove
            </Button>
          </Group>
        ))}
        <Group align="flex-end">
          <Select label="Add role" data={Object.entries(roleLabel).map(([value, label]) => ({ value, label }))} value={role} onChange={setRole} allowDeselect={false} w={170} />
          <Select label="Applies to" data={scopeOptions(sites, orgId)} value={scope} onChange={setScope} allowDeselect={false} style={{ flex: 1 }} />
          <Button onClick={() => add.mutate()} loading={add.isPending}>
            Add
          </Button>
        </Group>
        {error && <Alert color="red">{error}</Alert>}
      </Stack>
    </Modal>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Checkbox, Group, Loader, NumberInput, PasswordInput, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type MySecurity } from "../api/client";
import { dateTime } from "../api/format";
import { CopyText } from "../components/common";
import { createCredential, webauthnSupported } from "../api/webauthn";

export function AccountPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["my-security"], queryFn: () => api<MySecurity>("GET", "/me/security") });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["my-security"] });
  return (
    <Stack>
      <Title order={2}>Account security</Title>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      <PasswordCard />
      {q.data && <KeysCard data={q.data} onChange={refresh} />}
      {q.data && <TokensCard data={q.data} onChange={refresh} />}
    </Stack>
  );
}

function PasswordCard() {
  const [cur, setCur] = useState("");
  const [n1, setN1] = useState("");
  const [n2, setN2] = useState("");
  const [error, setError] = useState("");
  const change = useMutation({
    mutationFn: () => {
      if (n1 !== n2) throw new Error("The two new passwords are not the same.");
      return api("POST", "/auth/change-password", { current_password: cur, new_password: n1 });
    },
    onSuccess: () => (setCur(""), setN1(""), setN2(""), setError(""), notifications.show({ color: "green", message: "Password changed. Your other sessions were signed out." })),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Stack gap="xs" maw={420}>
      <Title order={4}>Password</Title>
      <form onSubmit={(e) => (e.preventDefault(), change.mutate())}>
        <Stack gap="xs">
          <PasswordInput label="Current password" value={cur} onChange={(e) => setCur(e.currentTarget.value)} autoComplete="current-password" required />
          <PasswordInput label="New password" value={n1} onChange={(e) => setN1(e.currentTarget.value)} autoComplete="new-password" required />
          <PasswordInput label="Repeat the new password" value={n2} onChange={(e) => setN2(e.currentTarget.value)} autoComplete="new-password" required />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={change.isPending} w="fit-content">
            Change password
          </Button>
        </Stack>
      </form>
    </Stack>
  );
}

function KeysCard({ data, onChange }: { data: MySecurity; onChange: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const add = useMutation({
    mutationFn: async () => {
      const begin = await api<{ ceremony: string; options: { publicKey: Record<string, unknown> } }>("POST", "/me/security-keys/begin", {});
      const cred = await createCredential(begin.options);
      return api("POST", `/me/security-keys/finish?ceremony=${begin.ceremony}&name=${encodeURIComponent(name.trim())}`, cred);
    },
    onSuccess: () => (setName(""), setError(""), onChange()),
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api("DELETE", `/me/security-keys/${id}`),
    onSuccess: onChange,
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Stack gap="xs">
      <Title order={4}>Second factor</Title>
      <Text size="sm">
        Authenticator app: <b>{data.totp ? "set up" : "not set up"}</b>. To replace it, ask an administrator to reset your second factor.
      </Text>
      <Text size="sm" fw={500}>
        Security keys
      </Text>
      {data.security_keys.length === 0 && <Text size="sm">No security keys.</Text>}
      {data.security_keys.length > 0 && (
        <Table verticalSpacing="xs" fz="sm" aria-label="Security keys" maw={600}>
          <Table.Tbody>
            {data.security_keys.map((k) => (
              <Table.Tr key={k.id}>
                <Table.Td>{k.name}</Table.Td>
                <Table.Td>added {dateTime(k.created_at)}</Table.Td>
                <Table.Td>last used {dateTime(k.last_used_at)}</Table.Td>
                <Table.Td>
                  <Button size="compact-xs" variant="default" color="red" onClick={() => window.confirm(`Remove the key "${k.name}"?`) && remove.mutate(k.id)} aria-label={`Remove key ${k.name}`}>
                    Remove
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {data.webauthn_available && webauthnSupported() ? (
        <Group align="flex-end">
          <TextInput label="Name for a new key" placeholder="e.g. YubiKey 5" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={100} />
          <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!name.trim()}>
            Add security key
          </Button>
        </Group>
      ) : (
        <Text size="xs" c="dimmed">
          Security keys need the console to be opened at its https address (or localhost) in a browser that supports them.
        </Text>
      )}
      {error && <Alert color="red">{error}</Alert>}
    </Stack>
  );
}

function TokensCard({ data, onChange }: { data: MySecurity; onChange: () => void }) {
  const [name, setName] = useState("");
  const [days, setDays] = useState<number | string>(90);
  const [scopes, setScopes] = useState<string[]>([]);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ token: string }>("POST", "/me/api-tokens", { name: name.trim(), scopes, expires_in_days: Number(days) }),
    onSuccess: (r) => (setSecret(r.token), setName(""), setScopes([]), setError(""), onChange()),
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api("DELETE", `/me/api-tokens/${id}`), onSuccess: onChange, onError: (e) => setError(errorMessage(e)) });
  const toggle = (s: string) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  return (
    <Stack gap="xs">
      <Title order={4}>API tokens</Title>
      <Text size="sm" c="dimmed">
        For scripts and integrations: send <code>Authorization: Bearer azt_…</code> to <code>/api/v1/…</code>. A token can only do what you can do and what its scopes list, expires, and stops working if your account is disabled.
      </Text>
      {secret && (
        <Alert color="yellow" title="Copy the token now">
          It is shown only once.
          <CopyText value={secret} label="Copy token" />
        </Alert>
      )}
      {data.api_tokens.length > 0 && (
        <Table verticalSpacing="xs" fz="sm" aria-label="Your API tokens">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Scopes</Table.Th>
              <Table.Th>Expires</Table.Th>
              <Table.Th>Last used</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.api_tokens.map((t) => (
              <Table.Tr key={t.id} opacity={t.revoked_at ? 0.5 : 1}>
                <Table.Td>
                  {t.name} <Text span size="xs" c="dimmed">{t.prefix}…</Text>
                </Table.Td>
                <Table.Td>{t.scopes.join(", ")}</Table.Td>
                <Table.Td>{t.revoked_at ? <Badge color="gray">revoked</Badge> : dateTime(t.expires_at)}</Table.Td>
                <Table.Td>{dateTime(t.last_used_at)}</Table.Td>
                <Table.Td>
                  {!t.revoked_at && (
                    <Button size="compact-xs" variant="default" color="red" onClick={() => revoke.mutate(t.id)} aria-label={`Revoke token ${t.name}`}>
                      Revoke
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Stack gap="xs" maw={640}>
        <Group align="flex-end">
          <TextInput label="Token name" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={100} style={{ flex: 1 }} />
          <NumberInput label="Valid for (days)" min={1} max={365} value={days} onChange={setDays} w={140} />
        </Group>
        <Text size="sm" fw={500}>
          Scopes
        </Text>
        <Group gap="md">
          {data.token_scopes.map((s) => (
            <Checkbox key={s} label={s} checked={scopes.includes(s)} onChange={() => toggle(s)} size="xs" />
          ))}
        </Group>
        {error && <Alert color="red">{error}</Alert>}
        <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim() || scopes.length === 0} w="fit-content">
          Create token
        </Button>
      </Stack>
    </Stack>
  );
}

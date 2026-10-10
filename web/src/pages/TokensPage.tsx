import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Group, Modal, NumberInput, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { api, errorMessage, type EnrollmentToken, type Site } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";
import { DataTable, EmptyState, Icons, Page, PageHeader, Status, toast, useConfirm, type Column } from "../ui";
import { CommandBlock } from "../ui/CommandBlock";

interface Created {
  token: EnrollmentToken;
  enrollment_string: string;
  install_command: string;
  root_ca_pin: string;
}

// A stable empty list: a new [] on every render makes the table reset its page again and again while loading.
const NONE: EnrollmentToken[] = [];

export function TokensPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; max_uses: number; expires_in_hours: number; require_approval: boolean; site_id: string | null }>({ name: "", max_uses: 10, expires_in_hours: 24, require_approval: false, site_id: null });
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api<{ items: Site[] }>("GET", "/sites") });
  const [created, setCreated] = useState<Created | null>(null);
  const q = useQuery({ queryKey: ["tokens"], queryFn: () => api<{ items: EnrollmentToken[] }>("GET", "/enrollment-tokens") });
  const create = useMutation({
    mutationFn: () => api<Created>("POST", "/enrollment-tokens", form),
    onSuccess: (c) => {
      setOpen(false);
      setCreated(c);
      void qc.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api("POST", `/enrollment-tokens/${id}/revoke`, {}),
    onSuccess: () => (toast.success("Token revoked."), qc.invalidateQueries({ queryKey: ["tokens"] })),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const canWrite = can("enrollment:write");

  const columns = useMemo<Column<EnrollmentToken>[]>(
    () => [
      { id: "name", header: "Name", value: (t) => t.name, required: true, sortable: true, width: 260 },
      {
        id: "state",
        header: "State",
        value: (t) => t.state,
        sortable: true,
        width: 130,
        cell: (t) => <Status value={t.state} />,
        filter: {
          type: "select",
          options: [
            { value: "active", label: "Active" },
            { value: "expired", label: "Expired" },
            { value: "exhausted", label: "Used up" },
            { value: "revoked", label: "Revoked" },
          ],
        },
      },
      { id: "uses", header: "Uses", value: (t) => t.used_count, sortable: true, align: "right", width: 100, cell: (t) => <span className="cur-num">{t.used_count} / {t.max_uses}</span>, csv: (t) => `${t.used_count} / ${t.max_uses}` },
      {
        id: "approval",
        header: "Approval",
        value: (t) => (t.require_approval ? "required" : "automatic"),
        sortable: true,
        width: 130,
        filter: {
          type: "select",
          options: [
            { value: "required", label: "Required" },
            { value: "automatic", label: "Automatic" },
          ],
        },
      },
      { id: "expires", header: "Expires", value: (t) => new Date(t.expires_at).getTime(), sortable: true, width: 190, cell: (t) => dateTime(t.expires_at), csv: (t) => t.expires_at },
      { id: "created", header: "Issued", value: (t) => new Date(t.created_at).getTime(), sortable: true, width: 190, defaultHidden: true, cell: (t) => dateTime(t.created_at), csv: (t) => t.created_at },
    ],
    [],
  );

  return (
    <Page>
      <PageHeader
        title="Enrollment tokens"
        description="Tokens let new devices enroll. Keep them short-lived and limited in uses. Turn on approval to review each device before it is trusted."
        actions={
          canWrite ? (
            <Button leftSection={<Icons.Plus size={16} aria-hidden />} onClick={() => setOpen(true)}>
              New token
            </Button>
          ) : undefined
        }
      />
      <DataTable<EnrollmentToken>
        id="tokens"
        label="Enrollment tokens"
        data={q.data?.items ?? NONE}
        loading={q.isLoading}
        error={q.error}
        columns={columns}
        rowId={(t) => t.id}
        rowLabel={(t) => t.name}
        searchPlaceholder="Search tokens…"
        exportName="enrollment-tokens"
        initialSort={{ id: "expires", desc: true }}
        rowActions={(t) =>
          canWrite && t.state === "active" ? (
            <Button
              size="compact-sm"
              variant="subtle"
              color="red"
              leftSection={<Icons.Close size={14} aria-hidden />}
              aria-label={`Revoke ${t.name}`}
              loading={revoke.isPending && revoke.variables === t.id}
              onClick={async () => {
                const ok = await confirm({
                  title: `Revoke "${t.name}"?`,
                  message: "Devices can no longer enroll with this token. Devices that already enrolled with it are not affected.",
                  confirmLabel: "Revoke token",
                  danger: true,
                });
                if (ok) revoke.mutate(t.id);
              }}
            >
              Revoke
            </Button>
          ) : null
        }
        empty={
          <EmptyState
            icon={<Icons.NavEnrollment size={26} />}
            title="No enrollment tokens yet"
            description={canWrite ? "Use New token above to make one, then run the install command it shows on a Windows device." : "An administrator can create a token to enroll devices."}
          />
        }
      />

      <Modal opened={open} onClose={() => setOpen(false)} title="New enrollment token">
        <form onSubmit={(e) => (e.preventDefault(), create.mutate())}>
          <Stack>
            <TextInput label="Name" placeholder="e.g. Head office laptops" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} required maxLength={200} data-autofocus />
            <NumberInput label="Maximum uses" min={1} max={100000} value={form.max_uses} onChange={(v) => setForm({ ...form, max_uses: Number(v) || 1 })} />
            <NumberInput label="Valid for (hours)" min={1} max={8760} value={form.expires_in_hours} onChange={(v) => setForm({ ...form, expires_in_hours: Number(v) || 1 })} />
            {(sites.data?.items.length ?? 0) > 1 && (
              <Select label="Site" description="New devices join this site" data={sites.data!.items.map((s) => ({ value: s.id, label: s.name }))} value={form.site_id} onChange={(v) => setForm({ ...form, site_id: v })} placeholder="Default site" clearable />
            )}
            <Switch label="Require administrator approval for each device" checked={form.require_approval} onChange={(e) => setForm({ ...form, require_approval: e.currentTarget.checked })} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setOpen(false)}>
                Not now
              </Button>
              <Button type="submit" loading={create.isPending}>
                Create
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>

      <Modal opened={!!created} onClose={() => setCreated(null)} title="Token created" size="xl">
        {created && (
          <Stack>
            <Alert color="yellow" icon={<Icons.Warning size={18} aria-hidden />}>
              This is the only time the token is shown. Anyone with it can enroll devices until it expires or is used up.
            </Alert>
            <Text fw={500}>Install on a Windows device (elevated PowerShell or Command Prompt):</Text>
            <CommandBlock value={created.install_command} label="Copy install command" />
            <Text size="sm" c="dimmed">
              The agent verifies the server's certificate authority against this pin, carried inside the token: {created.root_ca_pin}
            </Text>
          </Stack>
        )}
      </Modal>
    </Page>
  );
}

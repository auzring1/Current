import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Alert, Badge, Button, Checkbox, Group, Loader, Modal, SegmentedControl, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useSession } from "../api/session";
import { api, errorMessage, type Device } from "../api/client";
import { ago } from "../api/format";
import { OnlineDot, StatusBadge } from "../components/common";
import { LicenseBanner } from "../components/LicenseBanner";

export function DevicesPage() {
  const [status, setStatus] = useState("all");
  const nav = useNavigate();
  const { can } = useSession();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const del = useMutation({
    mutationFn: (ids: string[]) => api<{ deleted: number; skipped: number }>("POST", "/devices/delete", { ids }),
    onSuccess: (r) => {
      notifications.show({ color: "green", message: `Deleted ${r.deleted} device${r.deleted === 1 ? "" : "s"}${r.skipped ? `; ${r.skipped} skipped (only revoked devices can be deleted)` : ""}.` });
      setSelected(new Set());
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: ["devices"] });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const q = useQuery({
    queryKey: ["devices", status],
    queryFn: () => api<{ items: Device[]; total: number }>("GET", `/devices?limit=500${status === "all" ? "" : `&status=${status}`}`),
    refetchInterval: 60_000,
  });
  const pending = useQuery({
    queryKey: ["devices", "pending-count"],
    queryFn: () => api<{ total: number }>("GET", "/devices?status=pending&limit=1"),
  });

  return (
    <>
      <LicenseBanner />
      <Group justify="space-between" mb="md">
        <Title order={2}>Devices</Title>
        <SegmentedControl
          value={status}
          onChange={(v) => (setStatus(v), setSelected(new Set()))}
          data={[
            { value: "all", label: "All" },
            { value: "pending", label: `Pending${pending.data?.total ? ` (${pending.data.total})` : ""}` },
            { value: "active", label: "Active" },
            { value: "revoked", label: "Revoked" },
          ]}
        />
      </Group>
      {can("devices:write") && selected.size > 0 && (
        <Group mb="sm">
          <Button color="red" variant="light" onClick={() => setConfirm(true)}>
            Delete selected
          </Button>
          <Text size="sm" c="dimmed">
            {selected.size} device{selected.size === 1 ? "" : "s"} selected
          </Text>
        </Group>
      )}
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && q.data.items.length === 0 && (
        <Alert color="blue" title="No devices yet">
          Create an enrollment token under <b>Enrollment</b> and run the install command on a Windows device.
        </Alert>
      )}
      {q.data && q.data.items.length > 0 && (
        <Table.ScrollContainer minWidth={900}>
          <Table highlightOnHover verticalSpacing="xs" aria-label="Devices">
            <Table.Thead>
              <Table.Tr>
                {can("devices:write") && status === "revoked" && (
                  <Table.Th w={36}>
                    <Checkbox
                      aria-label="Select all revoked devices"
                      checked={q.data.items.length > 0 && q.data.items.every((d) => selected.has(d.id))}
                      onChange={() => setSelected(q.data.items.every((d) => selected.has(d.id)) ? new Set() : new Set(q.data.items.map((d) => d.id)))}
                    />
                  </Table.Th>
                )}
                <Table.Th>Device</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Connection</Table.Th>
                <Table.Th>Operating system</Table.Th>
                <Table.Th>Model</Table.Th>
                <Table.Th>User</Table.Th>
                <Table.Th>Software</Table.Th>
                <Table.Th>Last seen</Table.Th>
                <Table.Th>Agent</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {q.data.items.map((d) => (
                <Table.Tr key={d.id} onClick={() => nav(`/devices/${d.id}`)} style={{ cursor: "pointer" }} data-testid="device-row">
                  {can("devices:write") && status === "revoked" && (
                    <Table.Td onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select ${d.hostname}`}
                        checked={selected.has(d.id)}
                        onChange={() =>
                          setSelected((cur) => {
                            const n = new Set(cur);
                            if (n.has(d.id)) n.delete(d.id);
                            else n.add(d.id);
                            return n;
                          })
                        }
                      />
                    </Table.Td>
                  )}
                  <Table.Td>
                    <Text fw={500}>{d.hostname}</Text>
                    {d.pending_reboot && (
                      <Badge size="xs" color="orange" variant="light">
                        reboot pending
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <StatusBadge status={d.status} />
                  </Table.Td>
                  <Table.Td>{d.status === "active" ? <OnlineDot online={d.online} /> : "—"}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{d.os_caption || "—"}</Text>
                    <Text size="xs" c="dimmed">
                      {d.os_build}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{[d.manufacturer, d.model].filter(Boolean).join(" ") || "—"}</Text>
                  </Table.Td>
                  <Table.Td>{d.logged_on_user || "—"}</Table.Td>
                  <Table.Td>{d.software_count || "—"}</Table.Td>
                  <Table.Td>{d.online ? "now" : ago(d.last_seen_at)}</Table.Td>
                  <Table.Td>{d.agent_version || "—"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Modal opened={confirm} onClose={() => setConfirm(false)} title={`Delete ${selected.size} device${selected.size === 1 ? "" : "s"}?`}>
        <Stack>
          <Text size="sm">
            Each device and everything stored about it (hardware, software inventory, jobs, certificates) is removed permanently. The audit log keeps the record. Only
            revoked devices can be deleted.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => del.mutate([...selected])} loading={del.isPending}>
              Delete permanently
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

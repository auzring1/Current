import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Alert, Badge, Group, Loader, SegmentedControl, Table, Text, Title } from "@mantine/core";
import { api, errorMessage, type Device } from "../api/client";
import { ago } from "../api/format";
import { OnlineDot, StatusBadge } from "../components/common";

export function DevicesPage() {
  const [status, setStatus] = useState("all");
  const nav = useNavigate();
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
      <Group justify="space-between" mb="md">
        <Title order={2}>Devices</Title>
        <SegmentedControl
          value={status}
          onChange={setStatus}
          data={[
            { value: "all", label: "All" },
            { value: "pending", label: `Pending${pending.data?.total ? ` (${pending.data.total})` : ""}` },
            { value: "active", label: "Active" },
            { value: "revoked", label: "Revoked" },
          ]}
        />
      </Group>
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
    </>
  );
}

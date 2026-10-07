import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Group, Loader, Modal, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type Device } from "../api/client";
import { ago, bytes, dateTime, duration } from "../api/format";
import { useSession } from "../api/session";
import { OnlineDot, StatusBadge } from "../components/common";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ wordBreak: "break-word" }}>
        {value || "—"}
      </Text>
    </div>
  );
}

export function DeviceDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["device", id], queryFn: () => api<Device>("GET", `/devices/${id}`), enabled: !!id });
  const refresh = () => qc.invalidateQueries({ queryKey: ["devices"] }).then(() => qc.invalidateQueries({ queryKey: ["device", id] }));
  const approve = useMutation({
    mutationFn: () => api("POST", `/devices/${id}/approve`, {}),
    onSuccess: () => (notifications.show({ color: "green", message: "Device approved." }), refresh()),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: () => api("POST", `/devices/${id}/revoke`, { reason }),
    onSuccess: () => (setRevokeOpen(false), setReason(""), notifications.show({ color: "green", message: "Device revoked and disconnected." }), refresh()),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const d = q.data;
  const hw = d?.hardware;

  return (
    <Drawer opened={!!id} onClose={onClose} position="right" size="xl" title={d?.hostname ?? "Device"}>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {d && (
        <Stack>
          <Group>
            <StatusBadge status={d.status} />
            {d.status === "active" && <OnlineDot online={d.online} />}
            {d.pending_reboot && <Text c="orange">Reboot pending</Text>}
          </Group>
          {d.status === "pending" && d.replaces_device_id && (
            <Alert color="yellow" title="Re-enrollment of known hardware">
              This device has the same hardware identity as an existing device. Approving it revokes the old identity ({d.replaces_device_id}).
            </Alert>
          )}
          {d.status === "revoked" && d.status_reason && <Alert color="red">Revoked: {d.status_reason}</Alert>}
          {can("devices:write") && (
            <Group>
              {d.status === "pending" && (
                <Button onClick={() => approve.mutate()} loading={approve.isPending}>
                  Approve
                </Button>
              )}
              {(d.status === "pending" || d.status === "active") && (
                <Button color="red" variant="light" onClick={() => setRevokeOpen(true)}>
                  {d.status === "pending" ? "Reject" : "Revoke"}
                </Button>
              )}
            </Group>
          )}
          <Title order={4}>Overview</Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Field label="Device ID" value={d.id} />
            <Field label="Last seen" value={d.online ? "connected now" : ago(d.last_seen_at)} />
            <Field label="Operating system" value={`${d.os_caption ?? ""} ${hw?.os_display_version ?? ""}`} />
            <Field label="Build" value={d.os_build} />
            <Field label="Logged-on user" value={d.logged_on_user} />
            <Field label="Last logged-on user" value={hw?.last_logged_on_user} />
            <Field label="Uptime" value={duration(d.uptime_s)} />
            <Field label="IP (last connection)" value={d.last_ip} />
            <Field label="Agent version" value={d.agent_version} />
            <Field label="Enrolled" value={dateTime(d.enrolled_at)} />
          </SimpleGrid>
          {hw && (
            <>
              <Title order={4}>Hardware</Title>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Field label="Manufacturer" value={hw.manufacturer} />
                <Field label="Model" value={hw.model} />
                <Field label="Serial number" value={hw.serial} />
                <Field label="Chassis" value={hw.chassis} />
                <Field label="CPU" value={`${hw.cpu_model ?? ""} (${hw.cpu_logical_cores ?? "?"} logical cores)`} />
                <Field label="Memory" value={bytes(hw.ram_bytes)} />
                <Field label="BIOS" value={hw.bios_version} />
                <Field label="Domain" value={hw.domain} />
                <Field label="Architecture" value={hw.arch} />
                <Field label="Time zone" value={hw.timezone} />
              </SimpleGrid>
              {!!hw.disks?.length && (
                <Table aria-label="Disks">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Disk</Table.Th>
                      <Table.Th>File system</Table.Th>
                      <Table.Th>Size</Table.Th>
                      <Table.Th>Free</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {hw.disks.map((k) => (
                      <Table.Tr key={k.mount}>
                        <Table.Td>{k.mount}</Table.Td>
                        <Table.Td>{k.filesystem}</Table.Td>
                        <Table.Td>{bytes(k.size_bytes)}</Table.Td>
                        <Table.Td>{bytes(k.free_bytes)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
              {!!hw.interfaces?.length && (
                <Table aria-label="Network interfaces">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Interface</Table.Th>
                      <Table.Th>MAC</Table.Th>
                      <Table.Th>Addresses</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {hw.interfaces.map((n) => (
                      <Table.Tr key={n.name}>
                        <Table.Td>{n.name}</Table.Td>
                        <Table.Td>{n.mac}</Table.Td>
                        <Table.Td>{n.addresses?.join(", ")}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              )}
            </>
          )}
          {!!d.certificates?.length && (
            <>
              <Title order={4}>Client certificates</Title>
              <Table aria-label="Certificates">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Serial</Table.Th>
                    <Table.Th>Expires</Table.Th>
                    <Table.Th>State</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {d.certificates.map((c) => (
                    <Table.Tr key={c.serial}>
                      <Table.Td ff="monospace" fz="xs">
                        {c.serial.slice(0, 16)}…
                      </Table.Td>
                      <Table.Td>{dateTime(c.not_after)}</Table.Td>
                      <Table.Td>{c.revoked_at ? "revoked" : "valid"}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
        </Stack>
      )}
      <Modal opened={revokeOpen} onClose={() => setRevokeOpen(false)} title="Revoke device">
        <Stack>
          <Text size="sm">
            The device is disconnected immediately and can never reconnect with its current identity. To manage it again, reinstall the agent
            with a new enrollment token.
          </Text>
          <TextInput label="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.currentTarget.value)} maxLength={500} />
          <Button color="red" onClick={() => revoke.mutate()} loading={revoke.isPending}>
            Revoke device
          </Button>
        </Stack>
      </Modal>
    </Drawer>
  );
}

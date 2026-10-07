import { useQuery } from "@tanstack/react-query";
import { Alert, Anchor, Badge, Group, Loader, Paper, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { Link } from "react-router-dom";
import { api, errorMessage, type ComplianceRow, type ReportOverview } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text fz={28} fw={600} c={color}>
        {value}
      </Text>
    </Paper>
  );
}

export function ReportsPage() {
  const { can } = useSession();
  const ov = useQuery({ queryKey: ["reports", "overview"], queryFn: () => api<ReportOverview>("GET", "/reports/overview"), refetchInterval: 60_000 });
  const rows = useQuery({ queryKey: ["reports", "compliance"], queryFn: () => api<{ items: ComplianceRow[] }>("GET", "/reports/compliance") });
  const o = ov.data;
  const total = o ? o.compliance.compliant! + o.compliance.non_compliant! + o.compliance.unknown! : 0;
  const pct = o && total > 0 ? Math.round((100 * o.compliance.compliant!) / total) : 0;
  const bad = (rows.data?.items ?? []).filter((r) => r.state !== "compliant");
  const jobs = new Map<string, Record<string, number>>();
  for (const j of o?.jobs_30d ?? []) jobs.set(j.type, { ...(jobs.get(j.type) ?? {}), [j.status]: j.count });
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Reports</Title>
        {can("inventory:export") && (
          <Anchor href="/api/v1/reports/compliance.csv" download>
            Export patch compliance (CSV)
          </Anchor>
        )}
      </Group>
      {(ov.isLoading || rows.isLoading) && <Loader />}
      {ov.error && <Alert color="red">{errorMessage(ov.error)}</Alert>}
      {o && (
        <>
          <SimpleGrid cols={{ base: 2, sm: 4 }}>
            <Stat label="Devices" value={o.devices.active ?? 0} />
            <Stat label="Online now" value={o.devices.online ?? 0} />
            <Stat label="Patch compliant" value={`${pct}%`} color={pct >= 90 ? "green" : pct >= 70 ? "orange" : "red"} />
            <Stat label="Waiting for a restart" value={o.devices.reboot_pending ?? 0} color={(o.devices.reboot_pending ?? 0) > 0 ? "orange" : undefined} />
            <Stat label="Non-compliant" value={o.compliance.non_compliant ?? 0} color={(o.compliance.non_compliant ?? 0) > 0 ? "red" : undefined} />
            <Stat label="Not scanned lately" value={o.compliance.unknown ?? 0} />
            <Stat label="Not seen for a week" value={o.devices.not_seen_for_a_week ?? 0} />
            <Stat label="Pending approval" value={o.devices.pending ?? 0} />
          </SimpleGrid>
          <Text size="xs" c="dimmed">
            Compliant = no approved or critical update missing, no failed install, and a Windows Update scan within the last week.
          </Text>
          <Title order={4} mt="md">
            Devices to look at
          </Title>
          {bad.length === 0 && <Alert color="green">Every scanned device is compliant.</Alert>}
          {bad.length > 0 && (
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="xs" fz="sm" aria-label="Devices that are not compliant">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Device</Table.Th>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Approved missing</Table.Th>
                    <Table.Th>Critical missing</Table.Th>
                    <Table.Th>Failed</Table.Th>
                    <Table.Th>Last scan</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {bad.slice(0, 200).map((r) => (
                    <Table.Tr key={r.device_id}>
                      <Table.Td>
                        <Anchor component={Link} to={`/devices/${r.device_id}`}>
                          {r.hostname}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={r.state === "non_compliant" ? "red" : "gray"} variant="light">
                          {r.state === "non_compliant" ? "non-compliant" : "not scanned lately"}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{r.approved_missing}</Table.Td>
                      <Table.Td>{r.critical_missing}</Table.Td>
                      <Table.Td>{r.failed_updates}</Table.Td>
                      <Table.Td>{dateTime(r.last_scan_at)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
          <Title order={4} mt="md">
            Jobs in the last 30 days
          </Title>
          {jobs.size === 0 && <Text size="sm">No jobs yet.</Text>}
          {jobs.size > 0 && (
            <Table verticalSpacing="xs" fz="sm" aria-label="Jobs in the last 30 days" maw={640}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Succeeded</Table.Th>
                  <Table.Th>Failed</Table.Th>
                  <Table.Th>Other</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {[...jobs.entries()].map(([type, byStatus]) => {
                  const ok = (byStatus.succeeded ?? 0) + (byStatus.succeeded_reboot ?? 0);
                  const failed = (byStatus.failed ?? 0) + (byStatus.rejected ?? 0);
                  const all = Object.values(byStatus).reduce((a, b) => a + b, 0);
                  return (
                    <Table.Tr key={type}>
                      <Table.Td>{type.replace(/_/g, " ")}</Table.Td>
                      <Table.Td>{ok}</Table.Td>
                      <Table.Td>{failed}</Table.Td>
                      <Table.Td>{all - ok - failed}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
    </Stack>
  );
}

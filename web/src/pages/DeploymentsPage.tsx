import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Group, Loader, Progress, Table, Text, Title } from "@mantine/core";
import { api, errorMessage, type DeploymentSummary } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";

export const deploymentColor: Record<string, string> = { active: "blue", completed: "green", cancelled: "gray", paused: "yellow" };

export const jobColor: Record<string, string> = {
  queued: "gray",
  sent: "gray",
  accepted: "blue",
  waiting: "yellow",
  running: "blue",
  succeeded: "green",
  succeeded_reboot: "teal",
  failed: "red",
  expired: "orange",
  cancelled: "gray",
  rejected: "red",
};

export function JobBadge({ status }: { status: string }) {
  return (
    <Badge color={jobColor[status] ?? "gray"} variant="light">
      {status.replace("_", " ")}
    </Badge>
  );
}

export function DeploymentsPage() {
  const { can } = useSession();
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["deployments", "list", offset],
    queryFn: () => api<{ items: DeploymentSummary[] }>("GET", `/deployments?limit=50&offset=${offset}`),
    refetchInterval: 30_000,
  });
  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Deployments</Title>
        {can("deployments:write") && (
          <Button component={Link} to="/deployments/new">
            New deployment
          </Button>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Install, update or remove software on devices. Progress updates live as devices report back.
      </Text>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && q.data.items.length === 0 && <Alert color="blue">No deployments yet. Import a package in the Catalog, then deploy it.</Alert>}
      {!!q.data?.items.length && (
        <Table.ScrollContainer minWidth={800}>
          <Table highlightOnHover verticalSpacing="xs" aria-label="Deployments">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Deployment</Table.Th>
                <Table.Th>Package</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Progress</Table.Th>
                <Table.Th>Created</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {q.data.items.map((d) => {
                const done = d.jobs_succeeded + d.jobs_failed;
                return (
                  <Table.Tr key={d.id} data-testid="deployment-row">
                    <Table.Td>
                      <Anchor component={Link} to={`/deployments/${d.id}`} fw={500} size="sm">
                        {d.name}
                      </Anchor>
                      <Text size="xs" c="dimmed">
                        {d.action} · {d.scope}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{d.package_name}</Text>
                      <Text size="xs" c="dimmed">
                        {d.version ?? "newest"}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={deploymentColor[d.status] ?? "gray"} variant="light">
                        {d.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td miw={200}>
                      <Progress.Root size="lg">
                        <Progress.Section value={d.jobs_total ? (d.jobs_succeeded / d.jobs_total) * 100 : 0} color="green" />
                        <Progress.Section value={d.jobs_total ? (d.jobs_failed / d.jobs_total) * 100 : 0} color="red" />
                      </Progress.Root>
                      <Text size="xs" c="dimmed">
                        {done} of {d.jobs_total} finished{d.jobs_failed ? `, ${d.jobs_failed} failed` : ""}
                      </Text>
                    </Table.Td>
                    <Table.Td>{dateTime(d.created_at)}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {(offset > 0 || (q.data?.items.length ?? 0) === 50) && (
        <Group mt="md">
          <Button variant="default" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
            Newer
          </Button>
          <Button variant="default" disabled={(q.data?.items.length ?? 0) < 50} onClick={() => setOffset(offset + 50)}>
            Older
          </Button>
        </Group>
      )}
    </>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Code, Group, Loader, Modal, ScrollArea, Stack, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type DeploymentDetail, type DeploymentJob, type JobDetail } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";
import { JobBadge, deploymentColor, jobColor } from "./DeploymentsPage";

const order = ["queued", "sent", "accepted", "waiting", "running", "succeeded", "succeeded_reboot", "failed", "rejected", "expired", "cancelled"];
const retryable = new Set(["failed", "expired", "rejected", "cancelled"]);

export function DeploymentPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const d = useQuery({ queryKey: ["deployment", id], queryFn: () => api<DeploymentDetail>("GET", `/deployments/${id}`), enabled: !!id, refetchInterval: 30_000 });
  const jobs = useQuery({
    queryKey: ["deployment", id, "jobs"],
    queryFn: () => api<{ items: DeploymentJob[] }>("GET", `/deployments/${id}/jobs?limit=1000`),
    enabled: !!id,
    refetchInterval: 30_000,
  });
  const cancel = useMutation({
    mutationFn: () => api("POST", `/deployments/${id}/cancel`, {}),
    onSuccess: () => (notifications.show({ color: "green", message: "Deployment cancelled." }), qc.invalidateQueries({ queryKey: ["deployment", id] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const retry = useMutation({
    mutationFn: (jobId: string) => api("POST", `/jobs/${jobId}/retry`, {}),
    onSuccess: () => (notifications.show({ color: "green", message: "Retry queued." }), qc.invalidateQueries({ queryKey: ["deployment", id] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const x = d.data;
  return (
    <>
      <Anchor component={Link} to="/deployments" size="sm">
        ← Deployments
      </Anchor>
      {d.isLoading && <Loader />}
      {d.error && <Alert color="red">{errorMessage(d.error)}</Alert>}
      {x && (
        <Stack mt="xs">
          <Group justify="space-between">
            <div>
              <Title order={2}>{x.name}</Title>
              <Text size="sm" c="dimmed">
                {x.action} {x.package_name} {x.version ?? "(newest)"} · {x.scope} · created {dateTime(x.created_at)}
              </Text>
            </div>
            <Group>
              <Badge size="lg" color={deploymentColor[x.status] ?? "gray"} variant="light" data-testid="deployment-status">
                {x.status}
              </Badge>
              {can("deployments:write") && x.status === "active" && (
                <Button variant="light" color="red" onClick={() => window.confirm("Cancel everything that has not finished?") && cancel.mutate()} loading={cancel.isPending}>
                  Cancel deployment
                </Button>
              )}
            </Group>
          </Group>
          <Group gap="xs">
            {order
              .filter((s) => (x.job_counts ?? {})[s])
              .map((s) => (
                <Badge key={s} color={jobColor[s]} variant="light" size="lg">
                  {(x.job_counts ?? {})[s]} {s.replace("_", " ")}
                </Badge>
              ))}
          </Group>
          {x.window && (
            <Text size="sm">
              Maintenance window: {(x.window.days ?? []).map((n) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n]).join(", ") || "every day"} from{" "}
              {String(Math.floor(x.window.start_minute / 60)).padStart(2, "0")}:{String(x.window.start_minute % 60).padStart(2, "0")} for {x.window.duration_minutes} minutes
              {x.window.tz ? ` (${x.window.tz})` : ", device-local time"}
            </Text>
          )}
          {x.unverified_confirmed && <Badge color="yellow" variant="light">deployed with unverified-package confirmation</Badge>}
          {jobs.isLoading && <Loader />}
          {jobs.data && (
            <Table.ScrollContainer minWidth={800}>
              <Table highlightOnHover verticalSpacing="xs" aria-label="Jobs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Device</Table.Th>
                    <Table.Th>Job</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Updated</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {(jobs.data.items ?? []).map((j) => (
                    <Table.Tr key={j.id} data-testid="job-row">
                      <Table.Td>
                        <Anchor component={Link} to={`/devices/${j.device_id}`} size="sm">
                          {j.hostname}
                        </Anchor>
                        {j.user_sid && (
                          <Text size="xs" c="dimmed">
                            user {j.user_sid}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{j.title}</Text>
                        {(j.attempt ?? 1) > 1 && (
                          <Text size="xs" c="dimmed">
                            attempt {j.attempt}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <JobBadge status={j.status} />
                        {j.status_reason && (
                          <Text size="xs" c="dimmed">
                            {j.status_reason}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>{dateTime(j.finished_at ?? j.started_at ?? j.sent_at ?? j.created_at)}</Table.Td>
                      <Table.Td ta="right">
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          <Button size="compact-xs" variant="default" onClick={() => setOpen(j.id)}>
                            Details
                          </Button>
                          {can("deployments:write") && retryable.has(j.status) && (
                            <Button size="compact-xs" variant="light" onClick={() => retry.mutate(j.id)} loading={retry.isPending && retry.variables === j.id}>
                              Retry
                            </Button>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Stack>
      )}
      {open && <JobModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function JobModal({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["job", id], queryFn: () => api<JobDetail>("GET", `/jobs/${id}`), refetchInterval: 15_000 });
  const j = q.data;
  return (
    <Modal opened onClose={onClose} title={j?.title ?? "Job"} size="xl">
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {j && (
        <Stack>
          <Group>
            <JobBadge status={j.status} />
            <Text size="sm">{j.hostname}</Text>
            {j.status_reason && <Text size="sm" c="dimmed">{j.status_reason}</Text>}
            {j.reboot_required && <Badge color="orange" variant="light">reboot required</Badge>}
          </Group>
          <Text size="sm">
            Attempt {j.attempt} · created {dateTime(j.created_at)} · not before {dateTime(j.not_before)} · expires {dateTime(j.expires_at)}
          </Text>
          {j.result && (
            <Stack gap={4}>
              {j.result.message && <Text size="sm">{j.result.message}</Text>}
              <Text size="xs" c="dimmed">
                exit code {j.exit_code ?? "—"} · detection {j.detection_passed == null ? "—" : j.detection_passed ? "passed" : "failed"}
                {j.result.installed_version ? ` · installed ${j.result.installed_version}` : ""}
                {j.result.already_satisfied ? " · already satisfied" : ""}
              </Text>
              {j.result.log_tail && (
                <>
                  <Text size="sm" fw={500}>
                    Installer log (tail)
                  </Text>
                  <ScrollArea.Autosize mah={240}>
                    <Code block>{j.result.log_tail}</Code>
                  </ScrollArea.Autosize>
                </>
              )}
            </Stack>
          )}
          <Text size="sm" fw={500}>
            Timeline
          </Text>
          <Table verticalSpacing={2} fz="xs" aria-label="Job timeline">
            <Table.Tbody>
              {(j.events ?? []).map((e) => (
                <Table.Tr key={e.id}>
                  <Table.Td w={170}>{dateTime(e.time)}</Table.Td>
                  <Table.Td w={110}>{e.kind}</Table.Td>
                  <Table.Td>{e.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      )}
    </Modal>
  );
}

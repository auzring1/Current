import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, FileInput, Group, Loader, MultiSelect, NumberInput, Select, Stack, Switch, Table, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, uploadAgentRelease, type AgentRelease, type AgentRollout, type AgentRolloutStatus, type Group as Grp } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";

interface Overview {
  items: AgentRelease[];
  rollout: AgentRollout;
  status: AgentRolloutStatus;
}

export function AgentUpdatesPage() {
  const { canOrg } = useSession();
  const canWrite = canOrg("releases:write");
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["agent-releases"], queryFn: () => api<Overview>("GET", "/agent-releases"), refetchInterval: 30_000 });
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api<{ items: Grp[] }>("GET", "/groups") });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["agent-releases"] });
  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: "available" | "withdrawn" }) => api("POST", `/agent-releases/${v.id}/status`, { status: v.status }),
    onSuccess: refresh,
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const del = useMutation({
    mutationFn: (id: string) => api("DELETE", `/agent-releases/${id}`),
    onSuccess: refresh,
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });

  const d = q.data;
  return (
    <Stack>
      <Title order={2}>Agent updates</Title>
      <Text size="sm" c="dimmed">
        Agents update themselves to a release published by the vendor. Upload a release (the binary and its signed <code>.rnr</code> bundle), choose it as the target, and the agents move over in batches: a pilot group first, then everyone. An agent verifies the vendor signature itself, switches to the new copy and goes back to the old one automatically if the new one does not connect within ten minutes.
      </Text>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {d && (
        <>
          <Title order={4}>Versions in use</Title>
          <Table verticalSpacing="xs" fz="sm" aria-label="Agent versions in use" maw={420}>
            <Table.Tbody>
              {d.status.versions.map((v) => (
                <Table.Tr key={v.version}>
                  <Table.Td ff="monospace">{v.version}</Table.Td>
                  <Table.Td>{v.devices} devices</Table.Td>
                  <Table.Td>{v.online} online</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Title order={4} mt="md">
            Releases
          </Title>
          {d.items.length === 0 && <Alert color="blue">No release uploaded yet.</Alert>}
          {d.items.length > 0 && (
            <Table verticalSpacing="xs" fz="sm" aria-label="Agent releases">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Platform</Table.Th>
                  <Table.Th>Uploaded</Table.Th>
                  <Table.Th>Devices on it</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {d.items.map((r) => (
                  <Table.Tr key={r.id} data-testid="release-row">
                    <Table.Td ff="monospace">{r.version}</Table.Td>
                    <Table.Td>
                      {r.os}/{r.arch}
                    </Table.Td>
                    <Table.Td>{dateTime(r.created_at)}</Table.Td>
                    <Table.Td>{r.devices_on}</Table.Td>
                    <Table.Td>
                      {r.is_target && (
                        <Badge color="green" mr={4}>
                          target
                        </Badge>
                      )}
                      {r.status === "withdrawn" && <Badge color="gray">withdrawn</Badge>}
                    </Table.Td>
                    <Table.Td>
                      {canWrite && (
                        <Group gap="xs" justify="flex-end" wrap="nowrap">
                          <Button size="compact-xs" variant="default" onClick={() => setStatus.mutate({ id: r.id, status: r.status === "available" ? "withdrawn" : "available" })}>
                            {r.status === "available" ? "Withdraw" : "Make available"}
                          </Button>
                          {!r.is_target && (
                            <Button size="compact-xs" variant="default" color="red" onClick={() => window.confirm(`Delete release ${r.version}?`) && del.mutate(r.id)}>
                              Delete
                            </Button>
                          )}
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {canWrite && <UploadCard onDone={refresh} />}
          <RolloutCard rollout={d.rollout} status={d.status} releases={d.items} groups={groups.data?.items ?? []} canWrite={canWrite} onSaved={refresh} />
        </>
      )}
    </Stack>
  );
}

function UploadCard({ onDone }: { onDone: () => void }) {
  const [bin, setBin] = useState<File | null>(null);
  const [bundle, setBundle] = useState<File | null>(null);
  const [error, setError] = useState("");
  const up = useMutation({
    mutationFn: () => uploadAgentRelease(bin!, bundle!),
    onSuccess: (r) => (setBin(null), setBundle(null), setError(""), notifications.show({ color: "green", message: `Release ${r.version} uploaded.` }), onDone()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Stack gap="xs" maw={560} mt="md">
      <Title order={4}>Upload a release</Title>
      <FileInput label="Agent binary" placeholder="renovatio-agent.exe" value={bin} onChange={setBin} />
      <FileInput label="Signed bundle (.rnr)" placeholder="renovatio-agent-1.2.3.rnr" value={bundle} onChange={setBundle} accept=".rnr,application/json" />
      {error && <Alert color="red">{error}</Alert>}
      <Button onClick={() => up.mutate()} loading={up.isPending} disabled={!bin || !bundle} w="fit-content">
        Upload
      </Button>
    </Stack>
  );
}

function RolloutCard({ rollout, status, releases, groups, canWrite, onSaved }: { rollout: AgentRollout; status: AgentRolloutStatus; releases: AgentRelease[]; groups: Grp[]; canWrite: boolean; onSaved: () => void }) {
  const [target, setTarget] = useState<string | null>(rollout.release_id ?? null);
  const [pilots, setPilots] = useState<string[]>(rollout.pilot_group_ids);
  const [soak, setSoak] = useState<number | string>(rollout.soak_hours);
  const [thr, setThr] = useState<number | string>(rollout.success_threshold);
  const [batch, setBatch] = useState<number | string>(rollout.batch_per_tick);
  const [paused, setPaused] = useState(rollout.paused);
  const [error, setError] = useState("");
  useEffect(() => {
    setTarget(rollout.release_id ?? null);
    setPilots(rollout.pilot_group_ids);
    setSoak(rollout.soak_hours);
    setThr(rollout.success_threshold);
    setBatch(rollout.batch_per_tick);
    setPaused(rollout.paused);
  }, [rollout]);
  const save = useMutation({
    mutationFn: () => api("PUT", "/agent-rollout", { release_id: target, pilot_group_ids: pilots, soak_hours: Number(soak) || 0, success_threshold: Number(thr) || 90, batch_per_tick: Number(batch) || 100, paused }),
    onSuccess: () => (setError(""), notifications.show({ color: "green", message: "Rollout saved." }), onSaved()),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Stack gap="xs" maw={640} mt="md">
      <Title order={4}>Rollout</Title>
      {rollout.paused && rollout.paused_reason && <Alert color="orange" title="Rollout is on hold">{rollout.paused_reason}</Alert>}
      {status.waiting && <Alert color="blue">Devices outside the pilot are waiting: {status.waiting}.</Alert>}
      {target && (
        <Text size="sm">
          Updated {status.updated}, failed {status.failed}, in progress {status.queued}
          {status.pilot_devices > 0 ? `; pilot ${status.pilot_updated}/${status.pilot_devices} updated, ${status.pilot_failed} failed` : ""}.
        </Text>
      )}
      <Select
        label="Target release"
        description="Devices on other versions are updated to it. None = stop updating."
        data={releases.filter((r) => r.status === "available").map((r) => ({ value: r.id, label: `${r.version} (${r.os}/${r.arch})` }))}
        value={target}
        onChange={setTarget}
        clearable
        disabled={!canWrite}
      />
      <MultiSelect label="Pilot groups" description="These devices update first. Empty = everyone at once." data={groups.map((g) => ({ value: g.id, label: g.name }))} value={pilots} onChange={setPilots} searchable disabled={!canWrite} />
      <Group grow align="flex-start">
        <NumberInput label="Soak (hours)" description="Wait after the pilot" min={0} max={720} value={soak} onChange={setSoak} disabled={!canWrite} />
        <NumberInput label="Pilot success needed (%)" min={1} max={100} value={thr} onChange={setThr} disabled={!canWrite} />
        <NumberInput label="Devices per minute" min={1} max={1000} value={batch} onChange={setBatch} disabled={!canWrite} />
      </Group>
      <Switch label="Pause the rollout" checked={paused} onChange={(e) => setPaused(e.currentTarget.checked)} disabled={!canWrite} />
      {error && <Alert color="red">{error}</Alert>}
      {canWrite && (
        <Button onClick={() => save.mutate()} loading={save.isPending} w="fit-content">
          Save rollout
        </Button>
      )}
    </Stack>
  );
}

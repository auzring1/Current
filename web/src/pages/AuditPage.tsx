import { useState } from "react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Alert, Anchor, Badge, Button, Code, Group, Loader, Select, Table, Text, TextInput, Title } from "@mantine/core";
import { api, errorMessage, type AuditEntry } from "../api/client";
import { dateTime } from "../api/format";

interface Verify {
  intact: boolean;
  checked: number;
  broken_at: number;
  seconds: number;
}

export function AuditPage() {
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState<string | null>(null);
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState("");
  const query = () => {
    const p = new URLSearchParams();
    if (action.trim()) p.set("action", action.trim());
    if (outcome) p.set("outcome", outcome);
    if (actor.trim()) p.set("actor", actor.trim());
    if (from) p.set("from", new Date(from).toISOString());
    if (to) p.set("to", new Date(to).toISOString());
    return p.toString();
  };
  const q = useInfiniteQuery({
    queryKey: ["audit", applied],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<{ items: AuditEntry[] }>("GET", `/audit?limit=100${applied ? `&${applied}` : ""}${pageParam ? `&before_id=${pageParam}` : ""}`),
    getNextPageParam: (last) => (last.items.length === 100 ? last.items[last.items.length - 1]?.id : undefined),
  });
  const verify = useMutation({ mutationFn: () => api<Verify>("POST", "/audit/verify", {}) });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <Title order={2} mb="xs">
        Audit log
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        Append-only and hash-chained: each entry commits to the one before it, so an edit or deletion anywhere breaks the chain.
      </Text>
      <Group align="flex-end" mb="sm">
        <TextInput label="Action starts with" placeholder="e.g. user. or deployment" value={action} onChange={(e) => setAction(e.currentTarget.value)} w={220} />
        <Select label="Outcome" data={["success", "denied", "error"]} value={outcome} onChange={setOutcome} clearable placeholder="Any" w={130} />
        <TextInput label="Actor (id or IP)" value={actor} onChange={(e) => setActor(e.currentTarget.value)} w={200} />
        <TextInput label="From" type="datetime-local" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
        <TextInput label="To" type="datetime-local" value={to} onChange={(e) => setTo(e.currentTarget.value)} />
        <Button onClick={() => setApplied(query())}>Filter</Button>
        <Anchor href={`/api/v1/audit.csv${applied ? `?${applied}` : ""}`} download size="sm" mb={6}>
          Export CSV
        </Anchor>
        <Button variant="default" onClick={() => verify.mutate()} loading={verify.isPending}>
          Verify the chain
        </Button>
      </Group>
      {verify.data && (
        <Alert color={verify.data.intact ? "green" : "red"} mb="sm" role="status">
          {verify.data.intact ? `The chain is intact: ${verify.data.checked} entries checked in ${verify.data.seconds.toFixed(1)} s.` : `The chain is BROKEN at entry ${verify.data.broken_at}. Treat the log from there on as untrustworthy and investigate.`}
        </Alert>
      )}
      {verify.error && <Alert color="red">{errorMessage(verify.error)}</Alert>}
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      <Table.ScrollContainer minWidth={900}>
        <Table aria-label="Audit log" verticalSpacing={4} fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Time</Table.Th>
              <Table.Th>Action</Table.Th>
              <Table.Th>Outcome</Table.Th>
              <Table.Th>Actor</Table.Th>
              <Table.Th>Target</Table.Th>
              <Table.Th>Details</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td style={{ whiteSpace: "nowrap" }}>{dateTime(a.ts)}</Table.Td>
                <Table.Td>{a.action}</Table.Td>
                <Table.Td>
                  <Badge size="sm" color={a.outcome === "success" ? "green" : a.outcome === "denied" ? "orange" : "red"} variant="light">
                    {a.outcome}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {a.actor_name || a.actor_type}
                  {a.actor_ip ? ` · ${a.actor_ip}` : ""}
                </Table.Td>
                <Table.Td>{a.target_type ? `${a.target_type} ${a.target_ids.join(", ").slice(0, 40)}` : "—"}</Table.Td>
                <Table.Td>
                  <Code fz="xs">{JSON.stringify(a.details)}</Code>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {q.hasNextPage && (
        <Button mt="md" variant="light" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
          Load older entries
        </Button>
      )}
    </>
  );
}

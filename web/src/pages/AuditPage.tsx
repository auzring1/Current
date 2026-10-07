import { useInfiniteQuery } from "@tanstack/react-query";
import { Alert, Badge, Button, Code, Loader, Table, Text, Title } from "@mantine/core";
import { api, errorMessage, type AuditEntry } from "../api/client";
import { dateTime } from "../api/format";

export function AuditPage() {
  const q = useInfiniteQuery({
    queryKey: ["audit"],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<{ items: AuditEntry[] }>("GET", `/audit?limit=100${pageParam ? `&before_id=${pageParam}` : ""}`),
    getNextPageParam: (last) => (last.items.length === 100 ? last.items[last.items.length - 1]?.id : undefined),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <Title order={2} mb="xs">
        Audit log
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        Append-only and hash-chained. Verify integrity on the server with <code>auzring-server admin verify-audit</code>.
      </Text>
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
                  {a.actor_type}
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

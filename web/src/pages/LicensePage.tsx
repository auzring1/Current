import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Button, Group, Loader, Progress, Stack, Table, Text, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage } from "../api/client";
import { dateTime } from "../api/format";
import type { LicenseHistoryItem, LicenseStatus } from "../api/license";
import { useSession } from "../api/session";

const stateLabel: Record<LicenseStatus["state"], { label: string; color: string }> = {
  licensed: { label: "Licensed", color: "green" },
  grace: { label: "Expired (grace period)", color: "orange" },
  evaluation: { label: "Unlicensed (evaluation)", color: "gray" },
  invalid: { label: "License not usable", color: "red" },
};

const date = (iso: string | null | undefined, none = "never") => (iso ? new Date(iso).toLocaleDateString() : none);

export function LicensePage() {
  const { canOrg } = useSession();
  const canWrite = canOrg("license:write");
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const q = useQuery({ queryKey: ["license"], queryFn: () => api<LicenseStatus>("GET", "/license"), refetchInterval: 60_000 });
  const history = useQuery({ queryKey: ["license-history"], queryFn: () => api<{ items: LicenseHistoryItem[] }>("GET", "/license/history") });
  const install = useMutation({
    mutationFn: () => api<LicenseStatus>("PUT", "/license", { license: text.trim() }),
    onSuccess: (s) => {
      notifications.show({ color: "green", message: `License installed. ${s.message}` });
      setText("");
      void qc.invalidateQueries({ queryKey: ["license"] });
      void qc.invalidateQueries({ queryKey: ["license-history"] });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });

  const s = q.data;
  const lic = s?.license;
  return (
    <Stack maw={900}>
      <Title order={2}>License</Title>
      <Text size="sm" c="dimmed">
        A license is a signed text you receive from the vendor. It is checked on this server, offline: nothing is ever sent to the vendor. Without a license the server runs
        as an evaluation limited to {s?.evaluation_max_devices ?? 25} enrolled devices. A license problem only stops <b>new</b> devices from being enrolled or approved; existing devices,
        deployments, security updates, sign-in and revoking keep working.
      </Text>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {s && (
        <>
          <Group>
            <Badge size="lg" color={stateLabel[s.state].color} data-testid="license-state">
              {stateLabel[s.state].label}
            </Badge>
            <Text size="sm">{s.message}</Text>
          </Group>
          {!s.configured && (
            <Alert color="yellow" title="Licensing is not configured in this build">
              This build contains no vendor license key, so licenses cannot be verified and the evaluation limit applies.
            </Alert>
          )}
          <div>
            <Text size="sm" fw={500} data-testid="license-usage">
              {s.devices} of {s.max_devices} devices enrolled
              {s.pending_devices > 0 ? ` (${s.pending_devices} waiting for approval)` : ""}
            </Text>
            <Progress value={Math.min(100, (s.devices / Math.max(1, s.max_devices)) * 100)} color={s.at_capacity ? "orange" : "blue"} mt={4} aria-label="Device usage" />
          </div>
          {lic && (
            <Table verticalSpacing="xs" fz="sm" aria-label="Installed license" maw={640}>
              <Table.Tbody>
                <Table.Tr><Table.Th w={180}>Licensee</Table.Th><Table.Td data-testid="license-licensee">{lic.licensee}</Table.Td></Table.Tr>
                <Table.Tr><Table.Th>License ID</Table.Th><Table.Td ff="monospace">{lic.license_id}</Table.Td></Table.Tr>
                <Table.Tr><Table.Th>Devices covered</Table.Th><Table.Td>{lic.max_devices}</Table.Td></Table.Tr>
                <Table.Tr><Table.Th>Valid from</Table.Th><Table.Td>{date(lic.not_before)}</Table.Td></Table.Tr>
                <Table.Tr><Table.Th>Subscription ends</Table.Th><Table.Td>{date(lic.expires_at)}</Table.Td></Table.Tr>
                <Table.Tr>
                  <Table.Th>Agent updates until</Table.Th>
                  <Table.Td>{lic.updates_until ? date(lic.updates_until) : "no limit"}</Table.Td>
                </Table.Tr>
                <Table.Tr><Table.Th>Features</Table.Th><Table.Td>{lic.features.length ? lic.features.join(", ") : "none"}</Table.Td></Table.Tr>
                {lic.notes && <Table.Tr><Table.Th>Notes</Table.Th><Table.Td>{lic.notes}</Table.Td></Table.Tr>}
              </Table.Tbody>
            </Table>
          )}
        </>
      )}
      {canWrite ? (
        <Stack gap="xs">
          <Title order={4}>Install or renew a license</Title>
          <Textarea
            label="License text"
            description="Paste the whole text, starting with AZL1."
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            minRows={4}
            autosize
            maxRows={10}
            spellCheck={false}
            styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
            data-testid="license-input"
          />
          <Button w={160} onClick={() => install.mutate()} loading={install.isPending} disabled={text.trim() === ""} data-testid="license-install">
            Install license
          </Button>
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          Only administrators can install a license.
        </Text>
      )}
      <Title order={4} mt="md">
        History
      </Title>
      {history.data && history.data.items.length === 0 && <Text size="sm" c="dimmed">No license has been installed.</Text>}
      {history.data && history.data.items.length > 0 && (
        <Table verticalSpacing="xs" fz="sm" aria-label="License history">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Installed</Table.Th>
              <Table.Th>Licensee</Table.Th>
              <Table.Th>Devices</Table.Th>
              <Table.Th>Ends</Table.Th>
              <Table.Th>By</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {history.data.items.map((h) => (
              <Table.Tr key={h.id}>
                <Table.Td>{dateTime(h.installed_at)}</Table.Td>
                <Table.Td>{h.licensee}</Table.Td>
                <Table.Td>{h.max_devices}</Table.Td>
                <Table.Td>{date(h.expires_at)}</Table.Td>
                <Table.Td>{h.installed_by || "—"}</Table.Td>
                <Table.Td>{h.current && <Badge size="xs">in force</Badge>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

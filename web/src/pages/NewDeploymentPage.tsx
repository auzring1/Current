import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Alert, Anchor, Button, Checkbox, Group, Loader, MultiSelect, NumberInput, SegmentedControl, Select, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { hhmm, parseHHMM } from "../api/format";
import { api, errorMessage, type Device, type DeploymentPlan, type DeploymentRequest, type Group as Grp, type PackageDetail, type Pkg } from "../api/client";
import { PRODUCT_NAME } from "../brand.generated";

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function NewDeploymentPage() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [pkgId, setPkgId] = useState(sp.get("package") ?? "");
  const [name, setName] = useState("");
  const [action, setAction] = useState<"install" | "update" | "uninstall">("install");
  const [scope, setScope] = useState<"machine" | "user">("machine");
  const [version, setVersion] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [deviceIds, setDeviceIds] = useState<string[]>([]);
  const [startsAt, setStartsAt] = useState("");
  const [expiresH, setExpiresH] = useState<number | string>(72);
  const [useWindow, setUseWindow] = useState(false);
  const [days, setDays] = useState<string[]>([]);
  const [start, setStart] = useState("22:00");
  const [mins, setMins] = useState<number | string>(240);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<DeploymentPlan | null>(null);

  const pkgs = useQuery({ queryKey: ["catalog", "packages", ""], queryFn: () => api<{ items: Pkg[] }>("GET", "/catalog/packages?limit=500") });
  const detail = useQuery({ queryKey: ["catalog", "package", pkgId], queryFn: () => api<PackageDetail>("GET", `/catalog/packages/${pkgId}`), enabled: !!pkgId });
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => api<{ items: Grp[] }>("GET", "/groups") });
  const devices = useQuery({ queryKey: ["devices", "active"], queryFn: () => api<{ items: Device[] }>("GET", "/devices?status=active&limit=500") });

  const pkg = detail.data?.package ?? pkgs.data?.items.find((p) => p.id === pkgId);
  const needsConfirm = !!pkg && pkg.source === "winget" && !pkg.verified;
  const hasTargets = groupIds.length + deviceIds.length > 0;
  const versions = useMemo(() => detail.data?.versions.map((v) => v.version) ?? [], [detail.data]);

  const create = useMutation({
    mutationFn: () => {
      const body: DeploymentRequest = {
        name: name.trim() || `${action} ${pkg?.name ?? ""}`.trim(),
        action,
        package_id: pkgId,
        version: version || undefined,
        scope,
        group_ids: groupIds,
        device_ids: deviceIds,
        expires_in_hours: Number(expiresH) || 72,
        unverified_confirmed: confirmed,
      };
      if (startsAt) body.starts_at = new Date(startsAt).toISOString();
      if (useWindow) body.window = { days: days.map(Number), start_minute: parseHHMM(start), duration_minutes: Number(mins) || 60 };
      return api<DeploymentPlan>("POST", "/deployments", body);
    },
    onSuccess: (p) => {
      setPlan(p);
      void qc.invalidateQueries({ queryKey: ["deployments"] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (plan) {
    return (
      <Stack>
        <Title order={2}>Deployment queued</Title>
        <Text>
          {plan.jobs} job{plan.jobs === 1 ? "" : "s"} for {plan.devices} device{plan.devices === 1 ? "" : "s"}
          {plan.user_jobs ? `, ${plan.user_jobs} per-user` : ""}. Online devices start right away; offline devices pick the job up when they reconnect.
        </Text>
        {plan.per_user_policy && plan.per_user_found ? (
          <Alert color="blue">
            {plan.per_user_found} per-user installation{plan.per_user_found === 1 ? "" : "s"} found; policy: {plan.per_user_policy}.
          </Alert>
        ) : null}
        {(plan.skipped ?? []).length > 0 && (
          <Alert color="yellow" title={`${(plan.skipped ?? []).length} skipped`}>
            <Table verticalSpacing={2} fz="sm" aria-label="Skipped devices">
              <Table.Tbody>
                {(plan.skipped ?? []).map((s, i) => (
                  <Table.Tr key={i}>
                    <Table.Td>{s.device}</Table.Td>
                    <Table.Td>{s.reason}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Alert>
        )}
        <Group>
          <Button onClick={() => nav(`/deployments/${plan.deployment_id}`)}>Watch progress</Button>
        </Group>
      </Stack>
    );
  }

  const valid = !!pkgId && hasTargets && (!needsConfirm || confirmed) && (!useWindow || days.length > 0);
  return (
    <Stack maw={760}>
      <Anchor component={Link} to="/deployments" size="sm">
        ← Deployments
      </Anchor>
      <Title order={2}>New deployment</Title>
      <Select
        label="Package"
        searchable
        required
        data={(pkgs.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.identifier})` }))}
        value={pkgId || null}
        onChange={(v) => (setPkgId(v ?? ""), setVersion(""), setConfirmed(false))}
        rightSection={pkgs.isLoading ? <Loader size="xs" /> : undefined}
        placeholder="Choose from the catalog"
      />
      {needsConfirm && (
        <Alert color="yellow" title="Unverified package">
          <Checkbox
            label={`I understand this package has not been tested by ${PRODUCT_NAME} and I accept deploying it. This confirmation is recorded in the audit log.`}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.currentTarget.checked)}
          />
        </Alert>
      )}
      <Group grow align="flex-start">
        <div>
          <Text size="sm" fw={500} mb={4}>
            Action
          </Text>
          <SegmentedControl
            value={action}
            onChange={(v) => setAction(v as typeof action)}
            data={[
              { value: "install", label: "Install" },
              { value: "update", label: "Update" },
              { value: "uninstall", label: "Uninstall" },
            ]}
          />
        </div>
        <div>
          <Text size="sm" fw={500} mb={4}>
            Scope
          </Text>
          <SegmentedControl
            value={scope}
            onChange={(v) => setScope(v as typeof scope)}
            data={[
              { value: "machine", label: "Machine-wide" },
              { value: "user", label: "Per user" },
            ]}
          />
        </div>
      </Group>
      <Text size="xs" c="dimmed">
        {action === "update"
          ? "Update only touches devices that have an older version installed."
          : action === "uninstall"
            ? "Uninstall removes every matching installation found by inventory."
            : scope === "user"
              ? "A per-user install runs as each user of the device, at their next logon if they are signed out."
              : "A machine-wide install runs as the system and applies to everyone."}
      </Text>
      {action !== "uninstall" && (
        <Select
          label="Version"
          description="Newest allowed by the package's pin unless you choose one"
          data={versions}
          value={version || null}
          onChange={(v) => setVersion(v ?? "")}
          clearable
          placeholder="Newest"
        />
      )}
      <MultiSelect
        label="Groups"
        searchable
        data={(groups.data?.items ?? []).map((g) => ({ value: g.id, label: `${g.name} (${g.kind})` }))}
        value={groupIds}
        onChange={setGroupIds}
        placeholder="Dynamic and static groups"
      />
      <MultiSelect
        label="Devices"
        searchable
        data={(devices.data?.items ?? []).map((d) => ({ value: d.id, label: d.hostname }))}
        value={deviceIds}
        onChange={setDeviceIds}
        placeholder="Individual devices"
      />
      <TextInput label="Name" description="Optional" value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={200} />
      <Group grow align="flex-start">
        <TextInput label="Not before" description="Empty = now" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.currentTarget.value)} />
        <NumberInput label="Give up after (hours)" min={1} max={720} value={expiresH} onChange={setExpiresH} />
      </Group>
      <Checkbox label="Only run inside a maintenance window (device-local time)" checked={useWindow} onChange={(e) => setUseWindow(e.currentTarget.checked)} />
      {useWindow && (
        <Group align="flex-end">
          <MultiSelect label="Days" data={dayNames.map((n, i) => ({ value: String(i), label: n }))} value={days} onChange={setDays} w={260} />
          <TextInput label="Starts" value={start} onChange={(e) => setStart(e.currentTarget.value)} w={90} aria-label="Window start" />
          <NumberInput label="Minutes" min={1} max={1440} value={mins} onChange={setMins} w={110} />
          <Text size="xs" c="dimmed" mb={8}>
            ends at {hhmm((parseHHMM(start) + (Number(mins) || 0)) % 1440)}
          </Text>
        </Group>
      )}
      {error && <Alert color="red">{error}</Alert>}
      <Group>
        <Button onClick={() => (setError(""), create.mutate())} loading={create.isPending} disabled={!valid}>
          Start deployment
        </Button>
        <Button variant="default" component={Link} to="/deployments">
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}

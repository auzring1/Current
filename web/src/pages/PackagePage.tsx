import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Card, Checkbox, Code, Group, Loader, Select, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type Detection, type PackageDetail, type PackageOverride } from "../api/client";
import { bytes, dateTime } from "../api/format";
import { useSession } from "../api/session";
import { PackageBadges } from "./CatalogPage";
import { PRODUCT_NAME } from "../brand.generated";

const policies = [
  { value: "", label: "Use the organization default" },
  { value: "report_only", label: "Report only: never touch per-user installs" },
  { value: "update_in_place", label: "Update per-user installs in place" },
  { value: "convert_to_machine", label: "Convert: remove the per-user copy and install machine-wide" },
  { value: "remove", label: "Remove per-user installs" },
];

const selfUpdatePolicies = [
  { value: "", label: "Default (vendor updater for self-updating apps)" },
  { value: "defer_to_vendor", label: "Defer to the vendor's updater" },
  { value: "enforce", label: "Enforce the pinned version anyway" },
];

export function PackagePage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["catalog", "package", id], queryFn: () => api<PackageDetail>("GET", `/catalog/packages/${id}`), enabled: !!id });
  const del = useMutation({
    mutationFn: () => api("DELETE", `/catalog/packages/${id}`),
    onSuccess: () => (notifications.show({ color: "green", message: "Package removed." }), qc.invalidateQueries({ queryKey: ["catalog"] }), nav("/catalog")),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const d = q.data;
  return (
    <>
      <Anchor component={Link} to="/catalog" size="sm">
        ← Catalog
      </Anchor>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {d && (
        <Stack mt="xs">
          <Group justify="space-between">
            <div>
              <Title order={2}>{d.package.name}</Title>
              <Text size="sm" c="dimmed">
                {d.package.identifier} · {d.package.publisher || "unknown publisher"}
              </Text>
            </div>
            <Group>
              {can("deployments:write") && (
                <Button component={Link} to={`/deployments/new?package=${d.package.id}`}>
                  Deploy
                </Button>
              )}
              {can("catalog:write") && (
                <Button variant="light" color="red" onClick={() => window.confirm(`Remove ${d.package.name} from the catalog?`) && del.mutate()}>
                  Remove
                </Button>
              )}
            </Group>
          </Group>
          <PackageBadges p={d.package} />
          {d.package.description && <Text size="sm">{d.package.description}</Text>}
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Field label="License" value={d.package.license} />
            <Field label="Homepage" value={d.package.homepage} />
            <Field label="Effective per-user policy" value={`${d.effective_user_scope_policy} (${d.effective_user_scope_policy_source || "default"})`} />
          </SimpleGrid>
          {!d.package.verified && d.package.source === "winget" && (
            <Alert color="yellow" title="Unverified package">
              This package has not passed the {PRODUCT_NAME} VM test matrix. Its installer type and silent switches come from the community manifest. You will be asked to confirm before deploying, and the confirmation is recorded in the audit log.
            </Alert>
          )}
          <Title order={4}>Versions and installers</Title>
          {(d.versions ?? []).map((v) => (
            <Card key={v.id} withBorder padding="sm">
              <Group justify="space-between" mb="xs">
                <Text fw={600}>{v.version}</Text>
                <Text size="xs" c="dimmed">
                  imported {dateTime(v.imported_at)}
                </Text>
              </Group>
              <Table.ScrollContainer minWidth={700}>
                <Table verticalSpacing={4} fz="sm" aria-label={`Installers of ${v.version}`}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Arch</Table.Th>
                      <Table.Th>Scope</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Size</Table.Th>
                      <Table.Th>SHA-256</Table.Th>
                      <Table.Th>Status</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {(v.installers ?? []).map((i) => (
                      <Table.Tr key={i.id}>
                        <Table.Td>{i.architecture}</Table.Td>
                        <Table.Td>{i.scope}</Table.Td>
                        <Table.Td>{i.type}</Table.Td>
                        <Table.Td>{bytes(i.size)}</Table.Td>
                        <Table.Td>
                          <Code>{i.sha256 ? i.sha256.slice(0, 16) + "…" : "—"}</Code>
                        </Table.Td>
                        <Table.Td>
                          {i.unsupported ? (
                            <Text size="xs" c="red">
                              not deployable: {i.unsupported}
                            </Text>
                          ) : (
                            <Badge size="xs" color="green" variant="light">
                              {i.server_content ? `served by ${PRODUCT_NAME}` : "vendor download"}
                            </Badge>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Card>
          ))}
          <Overrides detail={d} />
        </Stack>
      )}
    </>
  );
}

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

const detectionToText = (ds: Detection[] | undefined) =>
  (ds ?? []).map((d) => [d.kind, d.key, d.value_name ?? "", d.version ?? "", d.cmp ?? ""].join("|")).join("\n");

function textToDetection(t: string): Detection[] {
  return t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [kind = "registry", key = "", value_name = "", version = "", cmp = ""] = l.split("|").map((s) => s.trim());
      return { kind: kind as Detection["kind"], key, value_name, version, cmp: cmp as Detection["cmp"] };
    });
}

function Overrides({ detail }: { detail: PackageDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const o = detail.override;
  const [args, setArgs] = useState((o.silent_args ?? []).join(" "));
  const [pin, setPin] = useState(o.pin ?? "");
  const [excluded, setExcluded] = useState(!!o.excluded);
  const [userPolicy, setUserPolicy] = useState<string>(o.user_scope_policy ?? "");
  const [selfPolicy, setSelfPolicy] = useState<string>(o.self_update_policy ?? "");
  const [detection, setDetection] = useState(detectionToText(o.extra_detection));
  const [error, setError] = useState("");
  useEffect(() => setError(""), [args, pin, excluded, userPolicy, selfPolicy, detection]);
  const editable = can("catalog:override");
  const save = useMutation({
    mutationFn: () => {
      const body: PackageOverride = {
        silent_args: args.trim() ? args.trim().split(/\s+/) : [],
        extra_detection: textToDetection(detection),
        pin: pin.trim(),
        excluded,
        user_scope_policy: userPolicy as PackageOverride["user_scope_policy"],
        self_update_policy: selfPolicy as PackageOverride["self_update_policy"],
      };
      return api("PUT", `/catalog/packages/${detail.package.id}/overrides`, body);
    },
    onSuccess: () => (notifications.show({ color: "green", message: "Overrides saved." }), qc.invalidateQueries({ queryKey: ["catalog"] })),
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Card withBorder padding="md">
      <Title order={4} mb="xs">
        Overrides
      </Title>
      <Text size="sm" c="dimmed" mb="sm">
        Organization-specific changes to how this package is deployed. {editable ? "Every change is audited." : "Only administrators can change these."}
      </Text>
      <Stack>
        <TextInput
          label="Silent arguments"
          description="Replaces the manifest's switches. Only plain switches such as /S or /quiet are accepted."
          value={args}
          disabled={!editable}
          onChange={(e) => setArgs(e.currentTarget.value)}
        />
        <TextInput
          label="Version pin"
          description={'Empty (newest), "latest", "= 24.08" (exactly) or "< 25" (anything older than)'}
          value={pin}
          disabled={!editable}
          onChange={(e) => setPin(e.currentTarget.value)}
          maw={300}
        />
        <Select label="Per-user installs of this app" data={policies} value={userPolicy} disabled={!editable} onChange={(v) => setUserPolicy(v ?? "")} allowDeselect={false} />
        <Select label="Self-updating behaviour" data={selfUpdatePolicies} value={selfPolicy} disabled={!editable} onChange={(v) => setSelfPolicy(v ?? "")} allowDeselect={false} />
        <Textarea
          label="Extra detection rules"
          description="One per line: kind|key|value name|version|eq or ge. Kinds: msi, registry, file, appx."
          value={detection}
          disabled={!editable}
          onChange={(e) => setDetection(e.currentTarget.value)}
          autosize
          minRows={2}
          ff="monospace"
        />
        <Checkbox label="Exclude this package from deployments" checked={excluded} disabled={!editable} onChange={(e) => setExcluded(e.currentTarget.checked)} />
        {error && <Alert color="red">{error}</Alert>}
        {editable && (
          <Group>
            <Button onClick={() => save.mutate()} loading={save.isPending}>
              Save overrides
            </Button>
          </Group>
        )}
      </Stack>
    </Card>
  );
}

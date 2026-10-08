import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Select, Stack, Table, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, uploadContent, type CustomPackage, type ImportResult, type Pkg } from "../api/client";
import { useSession } from "../api/session";
import { PRODUCT_NAME } from "../brand.generated";

export function PackageBadges({ p }: { p: Pkg }) {
  return (
    <Group gap={4}>
      <Badge size="xs" variant="light" color={p.source === "custom" ? "grape" : "blue"}>
        {p.source}
      </Badge>
      {p.source === "winget" && (
        <Tooltip label={p.verified ? `Passed the ${PRODUCT_NAME} VM test matrix` : `Not yet verified by the ${PRODUCT_NAME} VM test matrix; deploying needs an explicit confirmation`}>
          <Badge size="xs" variant="light" color={p.verified ? "green" : "yellow"}>
            {p.verified ? "verified" : "unverified"}
          </Badge>
        </Tooltip>
      )}
      {p.self_updating && (
        <Tooltip label={`Updates itself; ${PRODUCT_NAME} defers to the vendor's updater unless you enforce versions in the package's overrides`}>
          <Badge size="xs" variant="light" color="gray">
            self-updating
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

export function CatalogPage() {
  const { can } = useSession();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [importing, setImporting] = useState(false);
  const [custom, setCustom] = useState(false);
  const list = useQuery({
    queryKey: ["catalog", "packages", q],
    queryFn: () => api<{ items: Pkg[] }>("GET", `/catalog/packages?limit=200${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  return (
    <>
      <Group justify="space-between" mb="xs">
        <Title order={2}>Catalog</Title>
        {can("catalog:write") && (
          <Group>
            <Button onClick={() => setImporting(true)}>Import from winget</Button>
            <Button variant="default" onClick={() => setCustom(true)}>
              Upload custom installer
            </Button>
          </Group>
        )}
      </Group>
      <Text size="sm" c="dimmed" mb="md">
        Software that can be deployed. Winget packages are imported as metadata only; each device downloads the installer from the vendor and the agent checks its SHA-256 and signature before running it.
      </Text>
      <TextInput placeholder="Filter imported packages" aria-label="Filter packages" value={q} onChange={(e) => setQ(e.currentTarget.value)} mb="md" maw={400} />
      {list.isLoading && <Loader />}
      {list.error && <Alert color="red">{errorMessage(list.error)}</Alert>}
      {list.data && list.data.items.length === 0 && (
        <Alert color="blue" title="Nothing imported yet">
          Import a package by its winget identifier, for example <b>7zip.7zip</b> or <b>Mozilla.Firefox</b>, or upload your own installer.
        </Alert>
      )}
      {!!list.data?.items.length && (
        <Table highlightOnHover verticalSpacing="xs" aria-label="Packages">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Package</Table.Th>
              <Table.Th>Publisher</Table.Th>
              <Table.Th>Versions</Table.Th>
              <Table.Th>Flags</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.data.items.map((p) => (
              <Table.Tr key={p.id} data-testid="package-row">
                <Table.Td>
                  <Anchor component={Link} to={`/catalog/${p.id}`} fw={500} size="sm">
                    {p.name}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {p.identifier}
                  </Text>
                </Table.Td>
                <Table.Td>{p.publisher || "—"}</Table.Td>
                <Table.Td>{p.version_count ?? 0}</Table.Td>
                <Table.Td>
                  <PackageBadges p={p} />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={(r) => (setImporting(false), nav(`/catalog/${r.package_id}`))} />}
      {custom && <CustomModal onClose={() => setCustom(false)} onDone={(r) => (setCustom(false), nav(`/catalog/${r.package_id}`))} />}
    </>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (r: ImportResult) => void }) {
  const qc = useQueryClient();
  const [id, setId] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  const search = useQuery({
    queryKey: ["catalog", "search", id],
    queryFn: () =>
      api<{
        imported: Pkg[];
        suggestions: { identifier: string; self_updating: boolean; note?: string }[];
        probe?: { identifier: string; versions?: string[]; error?: string };
      }>("GET", `/catalog/search?q=${encodeURIComponent(id)}`),
    enabled: id.trim().length >= 2,
  });
  const imp = useMutation({
    mutationFn: () => api<ImportResult>("POST", "/catalog/import", { identifier: id.trim(), version: version.trim() }),
    onSuccess: (r) => {
      notifications.show({ color: "green", message: `Imported ${r.identifier} ${r.version}: ${r.deployable} of ${r.installers} installers deployable.` });
      void qc.invalidateQueries({ queryKey: ["catalog"] });
      onDone(r);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal opened onClose={onClose} title="Import from winget" size="lg">
      <Stack>
        <TextInput
          label="Winget package identifier"
          description="Exactly as in the winget-pkgs repository, for example 7zip.7zip"
          value={id}
          onChange={(e) => (setId(e.currentTarget.value), setError(""))}
          data-autofocus
        />
        {search.data?.suggestions.length ? (
          <Group gap="xs">
            {search.data.suggestions.map((s) => (
              <Button key={s.identifier} size="compact-xs" variant="light" onClick={() => setId(s.identifier)}>
                {s.identifier}
              </Button>
            ))}
          </Group>
        ) : null}
        {search.data?.probe && (
          <Text size="sm" c={search.data.probe.error ? "red" : "dimmed"}>
            {search.data.probe.error ? search.data.probe.error : `Upstream versions: ${(search.data.probe.versions ?? []).slice(0, 8).join(", ")}${(search.data.probe.versions?.length ?? 0) > 8 ? ", …" : ""}`}
          </Text>
        )}
        <TextInput label="Version" description="Leave empty for the newest" value={version} onChange={(e) => setVersion(e.currentTarget.value)} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => imp.mutate()} loading={imp.isPending} disabled={!id.trim()}>
            Import
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const typeOptions = ["msi", "inno", "nsis", "burn", "exe", "portable", "zip"];

function CustomModal({ onClose, onDone }: { onClose: () => void; onDone: (r: ImportResult) => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState({ identifier: "", name: "", publisher: "", version: "", type: "msi", arch: "x64", scope: "machine", args: "", product_code: "", signer_subject: "", detect_key: "", detect_file: "" });
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (v: string | null) => setF((o) => ({ ...o, [k]: v ?? "" }));
  const save = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose an installer file.");
      const up = await uploadContent(file);
      const body: CustomPackage = {
        identifier: f.identifier.trim(),
        name: f.name.trim(),
        publisher: f.publisher.trim(),
        version: f.version.trim(),
        sha256: up.sha256,
        file_name: up.file_name,
        type: f.type as CustomPackage["type"],
        arch: f.arch as CustomPackage["arch"],
        scope: f.scope as CustomPackage["scope"],
        args: f.args.trim() ? f.args.trim().split(/\s+/) : [],
        product_code: f.product_code.trim(),
        signer_subject: f.signer_subject.trim(),
        detection: [
          ...(f.detect_key.trim() ? [{ kind: "registry" as const, key: f.detect_key.trim() }] : []),
          ...(f.detect_file.trim() ? [{ kind: "file" as const, key: f.detect_file.trim() }] : []),
        ],
      };
      return api<ImportResult>("POST", "/catalog/custom", body);
    },
    onSuccess: (r) => {
      notifications.show({ color: "green", message: `Added ${r.identifier} ${r.version}.` });
      void qc.invalidateQueries({ queryKey: ["catalog"] });
      onDone(r);
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const valid = file && f.identifier.trim() && f.name.trim() && f.version.trim();
  return (
    <Modal opened onClose={onClose} title="Upload a custom installer" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          The file is stored on this server and devices download it over their mutually authenticated channel. Its SHA-256 is signed into every job. Custom packages count as verified because you supplied the file.
        </Text>
        <div>
          <Text size="sm" fw={500} mb={4}>
            Installer file
          </Text>
          <input type="file" aria-label="Installer file" onChange={(e) => setFile(e.currentTarget.files?.[0] ?? null)} />
        </div>
        <Group grow align="flex-start">
          <TextInput label="Identifier" description="Letters, digits, dots, dashes" required value={f.identifier} onChange={(e) => set("identifier")(e.currentTarget.value)} />
          <TextInput label="Name" required value={f.name} onChange={(e) => set("name")(e.currentTarget.value)} />
        </Group>
        <Group grow align="flex-start">
          <TextInput label="Publisher" value={f.publisher} onChange={(e) => set("publisher")(e.currentTarget.value)} />
          <TextInput label="Version" required value={f.version} onChange={(e) => set("version")(e.currentTarget.value)} />
        </Group>
        <Group grow>
          <Select label="Installer type" data={typeOptions} value={f.type} onChange={set("type")} allowDeselect={false} />
          <Select label="Architecture" data={["x64", "x86", "arm64", "neutral"]} value={f.arch} onChange={set("arch")} allowDeselect={false} />
          <Select label="Scope" data={["machine", "user", "any"]} value={f.scope} onChange={set("scope")} allowDeselect={false} />
        </Group>
        <TextInput label="Silent arguments" description="Space-separated, e.g. /S or /VERYSILENT /NORESTART. Leave empty for MSI." value={f.args} onChange={(e) => set("args")(e.currentTarget.value)} />
        <Group grow align="flex-start">
          <TextInput label="MSI product code" description="{GUID}; used for detection and uninstall" value={f.product_code} onChange={(e) => set("product_code")(e.currentTarget.value)} />
          <TextInput label="Uninstall registry key" description="Detection key name, if not an MSI" value={f.detect_key} onChange={(e) => set("detect_key")(e.currentTarget.value)} />
        </Group>
        <TextInput label="Detection file path" description="e.g. %ProgramFiles%\\Acme\\tool.exe; the install counts as successful when it exists" value={f.detect_file} onChange={(e) => set("detect_file")(e.currentTarget.value)} />
        <TextInput label="Required signer (optional)" description="Pin the Authenticode subject the installer must be signed by" value={f.signer_subject} onChange={(e) => set("signer_subject")(e.currentTarget.value)} />
        {error && <Alert color="red">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid}>
            Upload and add
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

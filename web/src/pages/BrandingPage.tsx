import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Badge, Box, Button, ColorInput, FileButton, Group, Loader, Modal, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  api,
  ApiError,
  errorMessage,
  uploadBrandingAsset,
  type BrandingAssetKind,
  type BrandingSettings,
  type BrandingView,
} from "../api/client";
import { useSession } from "../api/session";
import { BrandPreview } from "../branding/BrandPreview";
import { checks, colorProblems, DEFAULT_ACCENT } from "../branding/contrast";
import { checkImageFile, LIMITS } from "../branding/images";

const SLOTS: { kind: BrandingAssetKind; label: string; help: string; checker?: "light" | "dark" }[] = [
  { kind: "logo_light", label: "Logo for light backgrounds", help: "Shown in the top bar and on the sign-in page in the light theme." },
  { kind: "logo_dark", label: "Logo for dark backgrounds", help: "Used in the dark theme. Without it the light logo is shown on a light chip.", checker: "dark" },
  { kind: "icon", label: "Square icon", help: "Shown instead of the logo when no logo is set." },
  { kind: "favicon", label: "Favicon", help: "The small icon in the browser tab." },
  { kind: "report_logo", label: "Report and email logo", help: "Printed at the top of exported reports and used in emails. Falls back to the light logo." },
];

const EMPTY: BrandingSettings = {
  org_name: "",
  product_name: "",
  accent_color: "",
  secondary_color: "",
  login_headline: "",
  login_message: "",
  login_footer: "",
  support_email: "",
  support_phone: "",
  support_url: "",
  report_footer: "",
};

const norm = (s: BrandingSettings): BrandingSettings => ({ ...EMPTY, ...s });

export function BrandingPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["branding-admin"], queryFn: () => api<BrandingView>("GET", "/settings/branding"), enabled: can("branding:write") });
  const [draft, setDraft] = useState<BrandingSettings>(EMPTY);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);
  const loaded = useRef("");

  // Take the stored settings into the form when they first load and after every save, but never overwrite edits in progress.
  useEffect(() => {
    if (!q.data) return;
    const key = JSON.stringify(q.data.settings);
    if (loaded.current !== key) {
      loaded.current = key;
      setDraft(norm(q.data.settings));
    }
  }, [q.data]);

  const accept = (v: BrandingView) => {
    qc.setQueryData(["branding-admin"], v);
    qc.setQueryData(["branding"], v.resolved); // the console re-themes at once
  };

  const save = useMutation({
    mutationFn: () => api<BrandingView>("PUT", "/settings/branding", draft),
    onSuccess: (v) => {
      accept(v);
      setServerErrors({});
      notifications.show({ color: "green", message: "Branding saved." });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "invalid_branding") setServerErrors(e.fields);
      else notifications.show({ color: "red", message: errorMessage(e) });
    },
  });
  const reset = useMutation({
    mutationFn: () => api<BrandingView>("POST", "/settings/branding/reset", {}),
    onSuccess: (v) => {
      accept(v);
      loaded.current = JSON.stringify(v.settings);
      setDraft(norm(v.settings));
      setServerErrors({});
      setConfirmReset(false);
      notifications.show({ color: "green", message: "Branding reset to the defaults." });
    },
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });

  const problems = useMemo(() => colorProblems(draft.accent_color ?? "", draft.secondary_color ?? ""), [draft.accent_color, draft.secondary_color]);
  const liveChecks = useMemo(() => {
    const p = colorProblems(draft.accent_color ?? "", draft.secondary_color ?? "");
    return p.accent?.startsWith("Use a") || p.secondary?.startsWith("Use a") ? [] : checks(draft.accent_color ?? "", draft.secondary_color ?? "");
  }, [draft.accent_color, draft.secondary_color]);

  if (!can("branding:write")) return <Alert color="yellow">Only administrators can change branding.</Alert>;
  if (q.isLoading) return <Loader />;
  if (q.error || !q.data) return <Alert color="red">{errorMessage(q.error)}</Alert>;
  const view = q.data;
  const dirty = JSON.stringify(norm(draft)) !== JSON.stringify(norm(view.settings));
  const blocked = !!problems.accent || !!problems.secondary;
  const set = (k: keyof BrandingSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setDraft({ ...draft, [k]: e.currentTarget.value });
    if (serverErrors[k]) setServerErrors({ ...serverErrors, [k]: "" });
  };
  const err = (k: keyof BrandingSettings) => serverErrors[k] || undefined;

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl">
      <Stack maw={640}>
        <Text c="dimmed" size="sm">
          Make this deployment look like yours. Everything here is stored on your server and changes are written to the audit log.
        </Text>

        <Title order={4}>Names</Title>
        <TextInput label="Organization name" description="Shown in the top bar, on the sign-in page, in page titles and on reports." value={draft.org_name} onChange={set("org_name")} maxLength={120} error={err("org_name")} />
        <TextInput
          label="Product name"
          description={`What the console calls itself. Leave empty for "${view.defaults.product_name}".`}
          placeholder={view.defaults.product_name}
          value={draft.product_name}
          onChange={set("product_name")}
          maxLength={60}
          error={err("product_name")}
        />

        <Title order={4} mt="md">
          Colors
        </Title>
        <ColorInput
          label="Accent color"
          description={`Buttons, links and focus rings. Leave empty for ${DEFAULT_ACCENT}.`}
          format="hex"
          placeholder={DEFAULT_ACCENT}
          value={draft.accent_color}
          onChange={(v) => setDraft({ ...draft, accent_color: v })}
          error={problems.accent ?? err("accent_color")}
          popoverProps={{ withinPortal: true }}
        />
        <ColorInput
          label="Secondary color (optional)"
          description="Used for graphics such as the line under the top bar."
          format="hex"
          placeholder="None"
          value={draft.secondary_color}
          onChange={(v) => setDraft({ ...draft, secondary_color: v })}
          error={problems.secondary ?? err("secondary_color")}
          popoverProps={{ withinPortal: true }}
        />
        <ContrastTable rows={liveChecks} />

        <Title order={4} mt="md">
          Sign-in page
        </Title>
        <TextInput label="Headline" placeholder={`Sign in to ${(draft.product_name ?? "").trim() || view.defaults.product_name}`} value={draft.login_headline} onChange={set("login_headline")} maxLength={120} error={err("login_headline")} />
        <Textarea label="Welcome message" autosize minRows={2} maxRows={6} value={draft.login_message} onChange={set("login_message")} maxLength={1000} error={err("login_message")} />
        <Textarea label="Footer or legal text (optional)" description="For example an authorized-use notice." autosize minRows={2} maxRows={6} value={draft.login_footer} onChange={set("login_footer")} maxLength={1000} error={err("login_footer")} />
        <Group grow align="flex-start">
          <TextInput label="Support email" type="email" value={draft.support_email} onChange={set("support_email")} error={err("support_email")} />
          <TextInput label="Support phone" value={draft.support_phone} onChange={set("support_phone")} error={err("support_phone")} />
        </Group>
        <TextInput label="Support link" description="An https:// address." placeholder="https://" value={draft.support_url} onChange={set("support_url")} error={err("support_url")} />

        <Title order={4} mt="md">
          Reports and emails
        </Title>
        <Textarea label="Footer text" description="Printed at the bottom of exported reports and added to emails." autosize minRows={2} maxRows={6} value={draft.report_footer} onChange={set("report_footer")} maxLength={500} error={err("report_footer")} />

        <Group mt="sm">
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || blocked}>
            Save changes
          </Button>
          <Button variant="default" onClick={() => (setDraft(norm(view.settings)), setServerErrors({}))} disabled={!dirty}>
            Discard changes
          </Button>
          <Button variant="outline" color="red" ml="auto" onClick={() => setConfirmReset(true)}>
            Reset to defaults
          </Button>
        </Group>
        {blocked && (
          <Text size="sm" c="red" role="alert">
            These colors cannot be saved until they pass the contrast checks.
          </Text>
        )}

        <Title order={4} mt="xl">
          Images
        </Title>
        <Text size="sm" c="dimmed">
          PNG or JPEG, up to 512 KB. Images are applied as soon as you upload them. They are re-encoded on the server, so metadata is removed. SVG is not accepted.
        </Text>
        {SLOTS.map((s) => (
          <ImageSlot key={s.kind} slot={s} view={view} onView={accept} />
        ))}
      </Stack>

      <Box style={{ position: "sticky", top: 72, alignSelf: "start" }}>
        <Title order={4} mb="xs">
          Preview
        </Title>
        <BrandPreview draft={draft} view={view} />
      </Box>

      <Modal opened={confirmReset} onClose={() => setConfirmReset(false)} title="Reset branding to the defaults?" centered>
        <Stack>
          <Text size="sm">
            This clears the organization name, product name, colors, sign-in texts, support contact, report footer and every uploaded image. The previous values stay in the audit log.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={() => reset.mutate()} loading={reset.isPending}>
              Reset to defaults
            </Button>
          </Group>
        </Stack>
      </Modal>
    </SimpleGrid>
  );
}

function ContrastTable({ rows }: { rows: ReturnType<typeof checks> }) {
  if (rows.length === 0) return null;
  return (
    <Table withTableBorder data-testid="contrast-table" aria-label="Contrast checks">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Where it is used (WCAG AA)</Table.Th>
          <Table.Th w={90}>Contrast</Table.Th>
          <Table.Th w={80}>Needs</Table.Th>
          <Table.Th w={96} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((c) => (
          <Table.Tr key={c.id} data-testid={`contrast-${c.id}`}>
            <Table.Td>
              <Group gap="xs" wrap="nowrap">
                <span style={{ display: "inline-block", width: 14, height: 14, borderRadius: 3, background: c.id.startsWith("accent_text") ? c.background : c.foreground, border: "1px solid #868e96", flex: "none" }} />
                <Text size="sm">{c.label}</Text>
              </Group>
            </Table.Td>
            <Table.Td>{c.ratio.toFixed(2)}:1</Table.Td>
            <Table.Td>{c.required.toFixed(1)}:1</Table.Td>
            <Table.Td>
              <Badge color={c.pass ? "green" : "red"} variant="filled" styles={{ label: { overflow: "visible" } }}>
                {c.pass ? "Pass" : "Fail"}
              </Badge>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function ImageSlot({ slot, view, onView }: { slot: (typeof SLOTS)[number]; view: BrandingView; onView: (v: BrandingView) => void }) {
  const info = view.assets[slot.kind];
  const [err, setErr] = useState("");
  const clearInput = useRef<() => void>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      await checkImageFile(file, slot.kind);
      return uploadBrandingAsset(slot.kind, file);
    },
    onSuccess: (v) => (setErr(""), onView(v), notifications.show({ color: "green", message: `${slot.label} updated.` })),
    onError: (e) => setErr(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api<BrandingView>("DELETE", `/settings/branding/assets/${slot.kind}`),
    onSuccess: (v) => (setErr(""), onView(v), notifications.show({ color: "green", message: `${slot.label} removed.` })),
    onError: (e) => setErr(errorMessage(e)),
  });
  return (
    <Group align="flex-start" wrap="nowrap" data-testid={`slot-${slot.kind}`}>
      <Box
        style={{
          width: 120,
          height: 64,
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px dashed #868e96",
          borderRadius: 6,
          background: slot.checker === "dark" ? "#1a1b1e" : "#ffffff",
        }}
      >
        {info ? <img src={info.url} alt={`${slot.label} (current)`} style={{ maxWidth: 112, maxHeight: 56 }} /> : <Text size="xs" c="dimmed">None</Text>}
      </Box>
      <Stack gap={4} style={{ flex: 1 }}>
        <Text fw={500} size="sm">
          {slot.label}
        </Text>
        <Text size="xs" c="dimmed">
          {slot.help} {LIMITS[slot.kind].hint}.{info ? ` Current: ${info.width} × ${info.height}, ${(info.size / 1024).toFixed(1)} KB.` : ""}
        </Text>
        <Group gap="xs">
          <FileButton
            accept="image/png,image/jpeg"
            resetRef={clearInput}
            onChange={(f) => {
              clearInput.current?.(); // choosing the same file again must work after a failure or a removal
              if (f) upload.mutate(f);
            }}
          >
            {(props) => (
              <Button {...props} size="xs" variant="default" loading={upload.isPending} aria-label={`Upload ${slot.label}`}>
                {info ? "Replace" : "Upload"}
              </Button>
            )}
          </FileButton>
          {info && (
            <Button size="xs" variant="subtle" color="red" onClick={() => remove.mutate()} loading={remove.isPending} aria-label={`Remove ${slot.label}`}>
              Remove
            </Button>
          )}
        </Group>
        {err && (
          <Text size="xs" c="red" role="alert">
            {err}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

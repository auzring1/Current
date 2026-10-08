import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Text, Textarea } from "@mantine/core";
import { api, errorMessage } from "../api/client";
import { dateTime } from "../api/format";
import type { LicenseHistoryItem, LicenseStatus } from "../api/license";
import { useSession } from "../api/session";
import { Card, DataTable, EmptyState, Icons, Page, PageHeader, Skel, StackedBar, StatusPill, toast, type Column, type PillKind } from "../ui";
import { KeyValue, Section } from "../ui/admin-kit";

const stateLabel: Record<LicenseStatus["state"], { label: string; kind: PillKind }> = {
  licensed: { label: "Licensed", kind: "success" },
  grace: { label: "Expired (grace period)", kind: "warning" },
  evaluation: { label: "Unlicensed (evaluation)", kind: "neutral" },
  invalid: { label: "License not usable", kind: "danger" },
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
      toast.success(`License installed. ${s.message}`);
      setText("");
      void qc.invalidateQueries({ queryKey: ["license"] });
      void qc.invalidateQueries({ queryKey: ["license-history"] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns = useMemo<Column<LicenseHistoryItem>[]>(
    () => [
      { id: "installed", header: "Installed", value: (h) => new Date(h.installed_at).getTime(), width: 180, primary: true, required: true, cell: (h) => dateTime(h.installed_at), csv: (h) => h.installed_at },
      { id: "licensee", header: "Licensee", value: (h) => h.licensee, width: 220, wrap: true },
      { id: "devices", header: "Devices", value: (h) => h.max_devices, align: "right", width: 100, cell: (h) => <span className="rnv-num">{h.max_devices}</span> },
      { id: "ends", header: "Ends", value: (h) => (h.expires_at ? new Date(h.expires_at).getTime() : 0), width: 130, cell: (h) => date(h.expires_at), csv: (h) => h.expires_at ?? "" },
      { id: "by", header: "By", value: (h) => h.installed_by || "", width: 180, cell: (h) => h.installed_by || "—" },
      {
        id: "state",
        header: "Status",
        value: (h) => (h.current ? "in force" : "replaced"),
        width: 130,
        cell: (h) =>
          h.current ? (
            <StatusPill kind="success" size="sm">
              In force
            </StatusPill>
          ) : (
            <StatusPill kind="neutral" size="sm" icon={Icons.Restore}>
              Replaced
            </StatusPill>
          ),
        filter: {
          type: "select",
          options: [
            { value: "in force", label: "In force" },
            { value: "replaced", label: "Replaced" },
          ],
        },
      },
    ],
    [],
  );

  const s = q.data;
  const lic = s?.license;
  const look = s ? stateLabel[s.state] : undefined;
  return (
    <Page>
      <PageHeader
        title="License"
        description={
          <>
            A license is a signed text you receive from the vendor. It is checked on this server, offline: nothing is ever sent to the vendor. Without a license the server runs as an evaluation limited to{" "}
            {s?.evaluation_max_devices ?? 25} enrolled devices. A license problem only stops <b>new</b> devices from being enrolled or approved; existing devices, deployments, security updates, sign-in and revoking keep working.
          </>
        }
      />
      {q.isLoading && (
        <Card>
          <div role="status" aria-label="Loading" style={{ display: "grid", gap: "var(--rnv-space-3)" }}>
            <Skel w="30%" h={20} />
            <Skel w="50%" h={14} />
            <Skel h={10} />
          </div>
        </Card>
      )}
      {q.error && (
        <Alert color="red" icon={<Icons.Danger size={18} aria-hidden />}>
          {errorMessage(q.error)}
        </Alert>
      )}
      {s && look && (
        <>
          {!s.configured && (
            <Alert color="yellow" icon={<Icons.Warning size={18} aria-hidden />} title="Licensing is not configured in this build">
              This build contains no vendor license key, so licenses cannot be verified and the evaluation limit applies.
            </Alert>
          )}
          <div className="rnv-cards">
            <Card title="Status" description="What this server is licensed for right now.">
              <div style={{ display: "grid", gap: "var(--rnv-space-4)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--rnv-space-3)" }}>
                  <span data-testid="license-state">
                    <StatusPill kind={look.kind}>{look.label}</StatusPill>
                  </span>
                  <Text size="sm">{s.message}</Text>
                </div>
                <div style={{ display: "grid", gap: "var(--rnv-space-2)" }}>
                  <Text size="sm" fw={600} data-testid="license-usage">
                    {s.devices} of {s.max_devices} devices enrolled
                    {s.pending_devices > 0 ? ` (${s.pending_devices} waiting for approval)` : ""}
                  </Text>
                  <StackedBar
                    label="Device usage"
                    slices={[
                      { label: "Enrolled", value: s.devices, token: s.at_capacity ? "warning" : "chart-1" },
                      { label: "Free", value: Math.max(0, s.max_devices - s.devices), token: "neutral" },
                    ]}
                  />
                  {s.at_capacity && (
                    <div>
                      <StatusPill kind="warning" size="sm">
                        {s.over_capacity ? "More devices than the license covers" : "Device limit reached"}
                      </StatusPill>
                    </div>
                  )}
                </div>
              </div>
            </Card>
            {lic && (
              <Card title="Installed license">
                <KeyValue
                  label="Installed license"
                  items={[
                    { label: "Licensee", value: lic.licensee, testId: "license-licensee" },
                    { label: "License ID", value: <span className="rnv-mono">{lic.license_id}</span> },
                    { label: "Devices covered", value: lic.max_devices },
                    { label: "Valid from", value: date(lic.not_before) },
                    { label: "Subscription ends", value: date(lic.expires_at) },
                    { label: "Agent updates until", value: lic.updates_until ? date(lic.updates_until) : "no limit" },
                    { label: "Features", value: lic.features.length ? lic.features.join(", ") : "none" },
                    ...(lic.notes ? [{ label: "Notes", value: lic.notes }] : []),
                  ]}
                />
              </Card>
            )}
          </div>
        </>
      )}
      {canWrite ? (
        <Card title="Install or renew a license" description="Paste the whole text, starting with RNL1. It takes effect at once.">
          <div style={{ display: "grid", gap: "var(--rnv-space-3)", maxWidth: 760 }}>
            <Textarea
              label="License text"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              minRows={4}
              autosize
              maxRows={10}
              spellCheck={false}
              styles={{ input: { fontFamily: "var(--rnv-font-mono)", fontSize: 12 } }}
              data-testid="license-input"
            />
            <Button w="fit-content" leftSection={<Icons.NavLicense size={16} aria-hidden />} onClick={() => install.mutate()} loading={install.isPending} disabled={text.trim() === ""} data-testid="license-install">
              Install license
            </Button>
          </div>
        </Card>
      ) : (
        <Text size="sm" c="dimmed">
          Only administrators can install a license.
        </Text>
      )}
      <Section title="License history" description="Every license that was installed on this server, newest first.">
        <DataTable<LicenseHistoryItem>
          id="license-history"
          label="License history"
          data={history.data?.items}
          loading={history.isLoading}
          error={history.error}
          columns={columns}
          rowId={(h) => h.id}
          rowLabel={(h) => h.licensee}
          initialSort={{ id: "installed", desc: true }}
          pageSize={10}
          empty={<EmptyState icon={<Icons.NavLicense size={26} />} title="No license has been installed" description="Until one is installed, the server runs as an evaluation." />}
        />
      </Section>
    </Page>
  );
}

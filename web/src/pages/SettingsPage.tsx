import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Loader, Select, Stack, Tabs, Text, Title } from "@mantine/core";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { api, errorMessage, type OrgSettings } from "../api/client";
import { useSession } from "../api/session";

const options = [
  { value: "report_only", label: "Report only: show per-user installs, never change them (default)" },
  { value: "update_in_place", label: "Update in place: update the per-user copy for each user" },
  { value: "convert_to_machine", label: "Convert: remove the per-user copy, then install machine-wide" },
  { value: "remove", label: "Remove per-user copies" },
];

/** The Settings area: General (for operators and administrators) and Branding (administrators). */
export function SettingsLayout() {
  const { can } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const tab = loc.pathname.startsWith("/settings/branding") ? "branding" : "general";
  return (
    <Stack>
      <Title order={2}>Settings</Title>
      <Tabs value={tab} onChange={(v) => nav(v === "branding" ? "/settings/branding" : "/settings")}>
        <Tabs.List>
          <Tabs.Tab value="general">General</Tabs.Tab>
          {can("branding:write") && <Tabs.Tab value="branding">Branding</Tabs.Tab>}
        </Tabs.List>
      </Tabs>
      <Outlet />
    </Stack>
  );
}

export function SettingsPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<OrgSettings>("GET", "/settings") });
  const [policy, setPolicy] = useState<string>("report_only");
  useEffect(() => {
    if (q.data) setPolicy(q.data.user_scope_policy);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api("PUT", "/settings", { user_scope_policy: policy }),
    onSuccess: () => (notifications.show({ color: "green", message: "Settings saved." }), qc.invalidateQueries({ queryKey: ["settings"] })),
    onError: (e) => notifications.show({ color: "red", message: errorMessage(e) }),
  });
  const editable = can("settings:write");
  return (
    <Stack maw={720}>
      {q.isLoading && <Loader />}
      {q.error && <Alert color="red">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <>
          <Select
            label="Default policy for per-user installs"
            description="What a deployment does about copies of an app that users installed for themselves. Individual packages can override this on their catalog page."
            data={options}
            value={policy}
            onChange={(v) => setPolicy(v ?? "report_only")}
            disabled={!editable}
            allowDeselect={false}
          />
          <Text size="sm" c="dimmed">
            Per-user changes run in the signed-in user's own context, never as the system, and only for users whose profile is present on the device.
          </Text>
          {editable ? (
            <Button w={160} onClick={() => save.mutate()} loading={save.isPending} disabled={policy === q.data.user_scope_policy}>
              Save
            </Button>
          ) : (
            <Text size="sm" c="dimmed">
              Only administrators can change settings.
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

import { useParams, useSearchParams } from "react-router-dom";
import { Alert } from "@mantine/core";
import { useSession } from "../api/session";
import { DataStatusCard, EventReference, NotificationExtras, ReportRuns, ReportSendNow, ThemePolicyCard, WebhookTest } from "../settings/extras";
import { SectionForm } from "../settings/SectionForm";
import { useSettingsSchema } from "../settings/SettingsShell";
import { Card, Icons, Skel } from "../ui";

/** One schema-driven Settings section (everything except General and Branding, which have their own pages). */
export function SettingsSectionPage() {
  const { section = "" } = useParams();
  const [params] = useSearchParams();
  const { canOrg } = useSession();
  const schema = useSettingsSchema();
  if (schema.isLoading) {
    return (
      <Card>
        <Skel h={36} />
      </Card>
    );
  }
  const sec = schema.data?.sections.find((s) => s.id === section);
  if (!sec) {
    return (
      <Alert color="yellow" icon={<Icons.Warning size={18} aria-hidden />}>
        {canOrg("settings:write") || schema.data?.sections.length ? "That settings section does not exist, or you may not open it." : "You may not change settings."}
      </Alert>
    );
  }
  const focus = params.get("field");
  return (
    <>
      {sec.id === "appearance" && <ThemePolicyCard />}
      <SectionForm
        key={sec.id}
        section={sec}
        focus={focus}
        itemActions={sec.id === "integrations" ? (f, item) => <WebhookTest field={f} item={item} /> : sec.id === "reports" ? (f, item) => <ReportSendNow field={f} item={item} /> : undefined}
        after={
          <>
            {sec.id === "notifications" && <NotificationExtras />}
            {sec.id === "integrations" && <EventReference />}
            {sec.id === "reports" && <ReportRuns />}
            {sec.id === "data" && <DataStatusCard />}
          </>
        }
      />
    </>
  );
}

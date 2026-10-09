import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Radio, TextInput } from "@mantine/core";
import { api, ApiError, errorMessage, type BrandingSettings, type BrandingView } from "../api/client";
import { dateTime } from "../api/format";
import { useSession } from "../api/session";
import { SYSTEM_THEME, THEMES, type ThemeDef } from "../design/themes";
import { Card, DataTable, EmptyState, Icons, StatusPill, toast, type Column } from "../ui";
import type { SettingsField, Values } from "./types";

/** A miniature of the console in a theme's own colors, so the choice can be judged before it is made. */
function ThemeMock({ t }: { t: ThemeDef }) {
  const k = t.tokens;
  return (
    <span className="rnv-set-theme__mock" style={{ background: k["bg"] }} aria-hidden="true">
      <span style={{ background: k["surface"], borderRight: `1px solid ${k["border"]}` }} />
      <span>
        <i style={{ background: k["accent"], width: "55%" }} />
        <i style={{ background: k["text-muted"], width: "80%", opacity: 0.55 }} />
        <i style={{ background: k["border-strong"], width: "65%" }} />
      </span>
    </span>
  );
}

/** Which themes people may choose and which one they start with. Kept with the branding record (D93). */
export function ThemePolicyCard() {
  const { can } = useSession();
  const qc = useQueryClient();
  const editable = can("branding:write");
  const q = useQuery({ queryKey: ["branding-admin"], queryFn: () => api<BrandingView>("GET", "/settings/branding"), enabled: editable });
  const [allowed, setAllowed] = useState<string[]>([]);
  const [def, setDef] = useState("");
  const [base, setBase] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!q.data) return;
    const a = q.data.settings.allowed_themes ?? [];
    const d = q.data.settings.default_theme ?? "";
    setAllowed(a);
    setDef(d);
    setBase(JSON.stringify([a, d]));
  }, [q.data]);
  const offered = (id: string) => allowed.length === 0 || allowed.includes(id);
  const save = useMutation({
    mutationFn: () => api<BrandingView>("PUT", "/settings/branding", { ...(q.data!.settings as BrandingSettings), allowed_themes: allowed, default_theme: def }),
    onSuccess: (v) => {
      qc.setQueryData(["branding-admin"], v);
      qc.setQueryData(["branding"], v.resolved);
      setErr("");
      toast.success("Theme choices saved.");
    },
    onError: (e) => setErr(e instanceof ApiError ? Object.values(e.fields)[0] ?? e.message : errorMessage(e)),
  });
  const dirty = JSON.stringify([allowed, def]) !== base;
  const problem = def !== "" && def !== SYSTEM_THEME && !offered(def) ? "The default theme must be one of the offered themes." : "";
  const toggle = (id: string, on: boolean) => {
    const all = THEMES.map((t) => t.id);
    const cur = allowed.length === 0 ? all : allowed;
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    setAllowed(next.length === all.length ? [] : next);
  };
  return (
    <Card
      title="Themes"
      description="Which themes people can use, and what they see until they choose. Everyone can still pick their own from the account menu; “follow my device” is always offered unless you restrict it."
      footer={
        editable ? (
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !!problem} leftSection={<Icons.Save size={16} aria-hidden />}>
            Save theme choices
          </Button>
        ) : (
          <span className="rnv-muted">Only administrators who may edit branding can change this.</span>
        )
      }
    >
      {q.isLoading && editable ? (
        <span className="rnv-muted">Loading…</span>
      ) : (
        <>
          {(problem || err) && (
            <Alert color="red" mb="sm" role="alert">
              {problem || err}
            </Alert>
          )}
          <Radio.Group value={def === "" ? SYSTEM_THEME : def} onChange={(v) => setDef(v === SYSTEM_THEME ? "" : v)} label="Default for everyone" description="The theme people see before they choose one.">
            <div className="rnv-set-themes" style={{ marginTop: 8 }}>
              <div className="rnv-set-theme">
                <span className="rnv-set-theme__mock" style={{ background: "linear-gradient(90deg, #ffffff 50%, #111827 50%)" }} aria-hidden="true" />
                <Radio value={SYSTEM_THEME} label="Follow the device" disabled={!editable} />
                <span className="rnv-muted">Light or dark, as the computer is set.</span>
              </div>
              {THEMES.map((t) => (
                <div className="rnv-set-theme" key={t.id}>
                  <ThemeMock t={t} />
                  <Radio value={t.id} label={t.name} disabled={!editable || !offered(t.id)} />
                  <Checkbox label="Offered to people" checked={offered(t.id)} onChange={(e) => toggle(t.id, e.currentTarget.checked)} disabled={!editable} />
                </div>
              ))}
            </div>
          </Radio.Group>
        </>
      )}
    </Card>
  );
}

interface LogRow {
  id: number;
  channel: string;
  event: string;
  target: string;
  status: string;
  attempts: number;
  last_error: string;
  created_at: string;
  sent_at: string | null;
}

/** Send a test message with the saved mail settings, and show what was sent or failed lately. */
export function NotificationExtras() {
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const log = useQuery({ queryKey: ["settings", "notification-log"], queryFn: () => api<{ items: LogRow[] }>("GET", "/settings/notifications/log?limit=50"), refetchInterval: 30_000 });
  const test = useMutation({
    mutationFn: () => api("POST", "/settings/notifications/test-email", { to }),
    onSuccess: () => setMsg({ ok: true, text: `A test message was sent to ${to}. Check that it arrived.` }),
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) }),
  });
  const columns = useMemo<Column<LogRow>[]>(
    () => [
      { id: "when", header: "When", width: 170, value: (r) => new Date(r.created_at).getTime(), csv: (r) => r.created_at, cell: (r) => dateTime(r.created_at) },
      { id: "event", header: "Event", width: 160, value: (r) => r.event.replace(/_/g, " ") },
      { id: "channel", header: "Channel", width: 100, value: (r) => r.channel },
      { id: "target", header: "To", width: 200, value: (r) => (r.channel === "webhook" ? "webhook" : r.target) },
      {
        id: "status",
        header: "Result",
        width: 120,
        value: (r) => r.status,
        cell: (r) => (
          <StatusPill kind={r.status === "sent" ? "success" : r.status === "failed" ? "danger" : "warning"} size="sm">
            {r.status === "pending" && r.attempts > 0 ? "retrying" : r.status}
          </StatusPill>
        ),
      },
      { id: "error", header: "Error", width: 280, wrap: true, value: (r) => r.last_error },
    ],
    [],
  );
  return (
    <>
      <Card title="Send a test message" description="Uses the mail settings as last saved. The mail server's own error is shown if it refuses.">
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <TextInput label="Send to" type="email" value={to} onChange={(e) => setTo(e.currentTarget.value)} placeholder="you@example.org" style={{ flex: "1 1 260px" }} />
          <Button onClick={() => (setMsg(null), test.mutate())} loading={test.isPending} disabled={!to.includes("@")} leftSection={<Icons.Mail size={16} aria-hidden />}>
            Send test
          </Button>
        </div>
        {msg && (
          <Alert mt="sm" color={msg.ok ? "green" : "red"} role={msg.ok ? "status" : "alert"}>
            {msg.text}
          </Alert>
        )}
      </Card>
      <Card title="Recent notifications" description="Deliveries and failures of the last days. Failed ones are retried a few times, then marked failed.">
        <DataTable<LogRow>
          id="notification-log"
          label="Recent notifications"
          data={log.data?.items}
          loading={log.isLoading}
          error={log.error}
          columns={columns}
          rowId={(r) => String(r.id)}
          rowLabel={(r) => `${r.event} to ${r.target}`}
          initialSort={{ id: "when", desc: true }}
          exportName="notifications"
          empty={<EmptyState icon={<Icons.Bell size={26} />} title="Nothing sent yet" description="Turn on a rule above and the first notification appears here." />}
        />
      </Card>
    </>
  );
}

interface EventDoc {
  event: string;
  when: string;
  payload: Record<string, unknown>;
}

/** The readable webhook reference: when each event fires, what the body looks like, how to check the signature. */
export function EventReference() {
  const q = useQuery({ queryKey: ["settings", "events"], queryFn: () => api<{ events: EventDoc[]; signature: string }>("GET", "/settings/events"), staleTime: 10 * 60_000 });
  return (
    <Card title="Webhook reference" description="Each delivery is a JSON POST. Respond with any 2xx status; anything else is retried a few times with a growing delay.">
      {q.isLoading && <span className="rnv-muted">Loading…</span>}
      {q.data && (
        <div style={{ display: "grid", gap: 16 }}>
          <p style={{ margin: 0 }}>
            <strong>Headers:</strong> <code>X-Renovatio-Event</code>, <code>X-Renovatio-Delivery</code> (unique id), <code>X-Renovatio-Timestamp</code> (Unix seconds) and, when the webhook has a secret, <code>X-Renovatio-Signature</code>.
          </p>
          <p style={{ margin: 0 }}>
            <strong>Checking the signature:</strong> {q.data.signature}. Reject deliveries whose timestamp is more than a few minutes old.
          </p>
          {q.data.events.map((e) => (
            <section key={e.event} aria-label={`Event ${e.event}`}>
              <h3 style={{ margin: "0 0 4px", fontSize: "var(--rnv-text-md)" }}>
                <code>{e.event}</code>
              </h3>
              <p style={{ margin: "0 0 6px" }} className="rnv-muted">
                {e.when}
              </p>
              <pre className="rnv-code" tabIndex={0} aria-label={`Example payload of ${e.event}`}>
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Per-webhook "Send test" button (needs the webhook to be saved first, because it uses the saved URL and secret). */
export function WebhookTest({ field, item }: { field: SettingsField; item: Values }) {
  const id = String(item["id"] ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const test = useMutation({
    mutationFn: () => api("POST", `/settings/integrations/webhooks/${id}/test`, {}),
    onSuccess: () => setMsg({ ok: true, text: "The receiver accepted the test event." }),
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) }),
  });
  if (field.key !== "webhooks") return null;
  return (
    <>
      {msg && (
        <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "rnv-muted" : "rnv-set-bad"} style={{ alignSelf: "center", marginRight: "auto" }}>
          {msg.text}
        </span>
      )}
      <Button size="compact-sm" variant="default" onClick={() => (setMsg(null), test.mutate())} loading={test.isPending} disabled={id === "" || id.startsWith("new")} title={id ? undefined : "Save first, then send a test"} leftSection={<Icons.Webhook size={14} aria-hidden />}>
        Send test
      </Button>
    </>
  );
}


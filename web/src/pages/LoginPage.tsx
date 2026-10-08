import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Anchor, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { api, errorMessage, setCsrf } from "../api/client";
import { useSession } from "../api/session";
import { CodeInput, RecoveryCodes, TotpQR } from "../components/common";
import { getAssertion, webauthnSupported } from "../api/webauthn";
import { BrandMark, useBranding, useDocumentTitle } from "../branding/BrandingProvider";

type Stage =
  | { kind: "password" }
  | { kind: "change_password" }
  | { kind: "verify"; methods: string[] }
  | { kind: "enroll"; secret: string; uri: string }
  | { kind: "codes"; codes: string[] };

export function LoginPage() {
  const nav = useNavigate();
  const { refresh } = useSession();
  const brand = useBranding();
  useDocumentTitle("Sign in");
  const [stage, setStage] = useState<Stage>({ kind: "password" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setErr("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  type Next = { mfa: string; csrf_token: string; totp_secret?: string; otpauth_uri?: string; methods?: string[] };
  const proceed = (r: Next) => {
    setCsrf(r.csrf_token);
    if (r.mfa === "change_password") setStage({ kind: "change_password" });
    else if (r.mfa === "enroll") setStage({ kind: "enroll", secret: r.totp_secret ?? "", uri: r.otpauth_uri ?? "" });
    else setStage({ kind: "verify", methods: r.methods ?? ["totp"] });
  };

  const login = () =>
    run(async () => {
      proceed(await api<Next>("POST", "/auth/login", { email: email.trim(), password }));
    });

  const changePassword = () =>
    run(async () => {
      if (newPassword !== newPassword2) throw new Error("The two new passwords are not the same.");
      proceed(await api<Next>("POST", "/auth/change-password", { current_password: password, new_password: newPassword }));
      setPassword("");
      setNewPassword("");
      setNewPassword2("");
    });

  const useKey = () =>
    run(async () => {
      const begin = await api<{ ceremony: string; options: { publicKey: Record<string, unknown> } }>("POST", "/auth/webauthn/begin", {});
      const cred = await getAssertion(begin.options);
      await finish(await api("POST", `/auth/webauthn/finish?ceremony=${begin.ceremony}`, cred));
    });

  const finish = async (r: { csrf_token: string; recovery_codes?: string[] }) => {
    setCsrf(r.csrf_token);
    if (r.recovery_codes?.length) {
      setStage({ kind: "codes", codes: r.recovery_codes });
      return;
    }
    await refresh();
    nav("/", { replace: true });
  };

  const verify = () =>
    run(async () => {
      try {
        await finish(await api("POST", "/auth/mfa", { code: code.trim() }));
      } catch (e) {
        setCode("");
        if ((e as { code?: string }).code === "mfa_locked") setStage({ kind: "password" });
        throw e;
      }
    });

  const enroll = () => run(async () => finish(await api("POST", "/auth/mfa/enroll", { code })));

  return (
    <Center mih="100vh" p="md">
      <Stack align="center" gap="md" maw="100%">
      <Paper withBorder p="xl" radius="md" w={440} maw="100%">
        <Stack>
          <BrandMark height={48} />
          <Title order={2} data-testid="login-headline">
            {brand.login_headline || `Sign in to ${brand.product_name}`}
          </Title>
          {brand.org_name && (
            <Text c="dimmed" size="sm" data-testid="login-org">
              {brand.org_name}
            </Text>
          )}
          {brand.login_message && (
            <Text size="sm" style={{ whiteSpace: "pre-line" }} data-testid="login-message">
              {brand.login_message}
            </Text>
          )}
          {stage.kind === "password" && (
            <form onSubmit={(e) => (e.preventDefault(), void login())}>
              <Stack>
                <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoComplete="username" required autoFocus />
                <PasswordInput label="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" required />
                <Button type="submit" loading={busy}>
                  Continue
                </Button>
              </Stack>
            </form>
          )}
          {stage.kind === "change_password" && (
            <form onSubmit={(e) => (e.preventDefault(), void changePassword())}>
              <Stack>
                <Alert color="blue">An administrator set a temporary password for you. Choose your own to continue.</Alert>
                <PasswordInput label="New password" value={newPassword} onChange={(e) => setNewPassword(e.currentTarget.value)} autoComplete="new-password" required autoFocus />
                <PasswordInput label="Repeat the new password" value={newPassword2} onChange={(e) => setNewPassword2(e.currentTarget.value)} autoComplete="new-password" required />
                <Button type="submit" loading={busy}>
                  Change password
                </Button>
              </Stack>
            </form>
          )}
          {stage.kind === "verify" && (
            <form onSubmit={(e) => (e.preventDefault(), void verify())}>
              <Stack>
                {stage.methods.includes("webauthn") && webauthnSupported() && (
                  <Button variant="default" onClick={() => void useKey()} loading={busy}>
                    Use a security key
                  </Button>
                )}
                {useRecovery ? (
                  <TextInput label="Recovery code" placeholder="xxxx-xxxx-xxxx" value={code} onChange={(e) => setCode(e.currentTarget.value)} autoComplete="off" autoFocus />
                ) : (
                  <>
                    <Text size="sm">Enter the 6-digit code from your authenticator app.</Text>
                    <CodeInput autoFocus value={code} onChange={setCode} />
                  </>
                )}
                <Button type="submit" loading={busy} disabled={!code} style={{ display: stage.methods.includes("totp") || useRecovery ? undefined : "none" }}>
                  Verify
                </Button>
                <Anchor component="button" type="button" size="sm" onClick={() => (setUseRecovery(!useRecovery), setCode(""))}>
                  {useRecovery ? "Use authenticator code" : "Use a recovery code instead"}
                </Anchor>
              </Stack>
            </form>
          )}
          {stage.kind === "enroll" && (
            <Stack>
              <Alert color="yellow">Your multi-factor authentication was reset. Set up an authenticator to continue.</Alert>
              <TotpQR uri={stage.uri} secret={stage.secret} />
              <CodeInput value={code} onChange={setCode} />
              <Button onClick={enroll} loading={busy} disabled={code.length !== 6}>
                Confirm
              </Button>
            </Stack>
          )}
          {stage.kind === "codes" && (
            <Stack>
              <RecoveryCodes codes={stage.codes} />
              <Button onClick={() => void refresh().then(() => nav("/", { replace: true }))}>I have saved them, continue</Button>
            </Stack>
          )}
          {err && (
            <Alert color="red" role="alert">
              {err}
            </Alert>
          )}
        </Stack>
      </Paper>
      <LoginFooter />
      </Stack>
    </Center>
  );
}

/** The optional legal text and support contact under the sign-in card. Everything here is plain text or a checked link. */
function LoginFooter() {
  const { login_footer: footer, support } = useBranding();
  if (!footer && !support.email && !support.phone && !support.url) return null;
  return (
    <Stack gap={4} align="center" w={440} maw="100%" data-testid="login-footer">
      {footer && (
        <Text size="xs" c="dimmed" ta="center" style={{ whiteSpace: "pre-line" }}>
          {footer}
        </Text>
      )}
      {(support.email || support.phone || support.url) && (
        <Text size="xs" ta="center">
          Need help?{" "}
          {support.email && (
            <Anchor href={`mailto:${support.email}`} size="xs">
              {support.email}
            </Anchor>
          )}
          {support.email && (support.phone || support.url) && " · "}
          {support.phone && (
            <Anchor href={`tel:${support.phone.replace(/[^0-9+]/g, "")}`} size="xs">
              {support.phone}
            </Anchor>
          )}
          {support.phone && support.url && " · "}
          {support.url && (
            <Anchor href={support.url} size="xs" target="_blank" rel="noopener noreferrer">
              Support site
            </Anchor>
          )}
        </Text>
      )}
    </Stack>
  );
}

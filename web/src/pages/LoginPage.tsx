import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Anchor, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { api, errorMessage, setCsrf } from "../api/client";
import { useSession } from "../api/session";
import { CodeInput, RecoveryCodes, TotpQR } from "../components/common";
import { getAssertion, webauthnSupported } from "../api/webauthn";

type Stage =
  | { kind: "password" }
  | { kind: "change_password" }
  | { kind: "verify"; methods: string[] }
  | { kind: "enroll"; secret: string; uri: string }
  | { kind: "codes"; codes: string[] };

export function LoginPage() {
  const nav = useNavigate();
  const { refresh } = useSession();
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
      <Paper withBorder p="xl" radius="md" w={440} maw="100%">
        <Stack>
          <Title order={2}>Sign in to Auzring</Title>
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
    </Center>
  );
}

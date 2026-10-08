import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Center, Checkbox, Paper, PasswordInput, Stack, Stepper, Text, TextInput, Title } from "@mantine/core";
import { api, errorMessage } from "../api/client";
import { CodeInput, RecoveryCodes, TotpQR } from "../components/common";
import { PRODUCT_NAME } from "../brand.generated";

export function SetupPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ token: "", email: "", org: "", name: "", password: "", password2: "", root: "", root2: "", code: "" });
  const [totp, setTotp] = useState<{ totp_secret: string; otpauth_uri: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.currentTarget.value });

  const begin = async () => {
    setErr("");
    setBusy(true);
    try {
      setTotp(await api("POST", "/setup/begin", { setup_token: f.token.trim(), email: f.email.trim() }));
      setStep(1);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    setErr("");
    if (f.password !== f.password2) return setErr("The passwords do not match.");
    if (f.root !== f.root2) return setErr("The CA passphrases do not match.");
    setBusy(true);
    try {
      const r = await api<{ recovery_codes: string[] }>("POST", "/setup/complete", {
        setup_token: f.token.trim(),
        org_name: f.org,
        display_name: f.name,
        email: f.email.trim(),
        password: f.password,
        root_passphrase: f.root,
        totp_code: f.code,
      });
      setCodes(r.recovery_codes);
      setStep(2);
      await qc.invalidateQueries({ queryKey: ["setup"] });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="xl" radius="md" w={620} maw="100%">
        <Stack>
          <Title order={2}>Set up {PRODUCT_NAME}</Title>
          <Stepper active={step} size="sm">
            <Stepper.Step label="Verify" description="Setup token">
              <Stack mt="md">
                <Text size="sm">
                  Enter the one-time setup token printed in the server log (<code>docker compose logs server</code>) and the email
                  address of the first administrator.
                </Text>
                <TextInput label="Setup token" value={f.token} onChange={set("token")} autoComplete="off" required />
                <TextInput label="Administrator email" type="email" value={f.email} onChange={set("email")} autoComplete="username" required />
                <Button onClick={begin} loading={busy} disabled={!f.token || !f.email}>
                  Continue
                </Button>
              </Stack>
            </Stepper.Step>
            <Stepper.Step label="Administrator" description="Account, MFA and CA">
              <Stack mt="md">
                <TextInput label="Organization name" value={f.org} onChange={set("org")} required />
                <TextInput label="Your name" value={f.name} onChange={set("name")} autoComplete="name" required />
                <PasswordInput
                  label="Password"
                  description="At least 12 characters. Long passphrases are best; common or breached passwords are rejected."
                  value={f.password}
                  onChange={set("password")}
                  autoComplete="new-password"
                  required
                />
                <PasswordInput label="Confirm password" value={f.password2} onChange={set("password2")} autoComplete="new-password" required />
                <Alert color="yellow" title="Certificate authority passphrase">
                  This passphrase protects the root of trust for every agent. It is never stored by the server. You will need it for rare
                  CA operations (rotating signing keys). Keep it offline, separate from your password.
                </Alert>
                <PasswordInput label="CA root passphrase (16+ characters)" value={f.root} onChange={set("root")} autoComplete="off" required />
                <PasswordInput label="Confirm CA root passphrase" value={f.root2} onChange={set("root2")} autoComplete="off" required />
                {totp && (
                  <>
                    <Text fw={500}>Multi-factor authentication (required)</Text>
                    <Text size="sm">Scan this code with an authenticator app (Microsoft Authenticator, 1Password, Google Authenticator…).</Text>
                    <TotpQR uri={totp.otpauth_uri} secret={totp.totp_secret} />
                  </>
                )}
                <CodeInput value={f.code} onChange={(v) => setF({ ...f, code: v })} />
                <Button onClick={complete} loading={busy} disabled={f.code.length !== 6}>
                  Create organization
                </Button>
              </Stack>
            </Stepper.Step>
            <Stepper.Step label="Recovery codes">
              <Stack mt="md">
                <RecoveryCodes codes={codes} />
                <Checkbox label="I have saved my recovery codes" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} />
                <Button disabled={!saved} onClick={() => nav("/login", { replace: true })}>
                  Continue to sign in
                </Button>
              </Stack>
            </Stepper.Step>
          </Stepper>
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

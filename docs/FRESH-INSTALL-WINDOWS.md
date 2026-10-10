# Fresh install on Windows 11 (server in Docker, agents on Windows)

This guide takes you from "wipe everything" to a working Current stack: the server in Docker on a Windows 11 machine, and the agent on that machine and/or other Windows machines or VMs. It assumes a current build (any build where every name is "Current"). Nothing from an earlier build carries over, so the first part removes it all.

Allow about 60 minutes, most of it waiting for downloads and the first Docker build.

**Terms used below**
- **Server machine:** the Windows 11 PC that runs Docker Desktop.
- **Ubuntu:** the Linux that lives inside Windows (WSL 2). The server steps run there, because the setup script is a bash script and the files must keep Linux permissions.
- **Agent machines:** every Windows machine that should be managed (it can be the server machine itself).

---

## Part 1: Remove the old installation

Do this on **every** machine that had the old agent, and on the server machine for Docker. Everything here is destructive on purpose.

### 1.1 Remove the old agent (each agent machine, PowerShell as Administrator)

<!-- old-names:begin -->
This project has been called "Auzring" and "Renovatio" before it became Current. The commands below remove an agent
installed from a build with either earlier name. Normal removal, which also deletes the device key and the files:

```powershell
foreach ($n in "Renovatio", "Auzring") {
  $old = "C:\Program Files\$n\Agent\slot-a\$($n.ToLower())-agent.exe"
  if (Test-Path $old) { & $old uninstall } else { "$n executable not found; use the manual steps below" }
}
```

If the agent was installed from the MSI, remove it as a program instead (Settings → Apps → Installed apps → "Renovatio Agent"
or "Auzring Agent" → Uninstall), or:

```powershell
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* |
  Where-Object { $_.DisplayName -like "*Renovatio*" -or $_.DisplayName -like "*Auzring*" } | Select-Object DisplayName, UninstallString
# then run the UninstallString it shows, or: msiexec /x "<path of the .msi you installed>" /qn
```

Manual clean-up (safe to run even if the steps above already worked; errors about missing items are fine):

```powershell
foreach ($n in "Renovatio", "Auzring") {
  $l = $n.ToLower()
  Stop-Service "${n}Agent" -Force -ErrorAction SilentlyContinue
  sc.exe delete "${n}Agent"
  schtasks /Delete /TN "\$n\rollback-check" /F
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
    "C:\Program Files\$n", "C:\Program Files\${n}Setup", `
    "C:\ProgramData\$n", "C:\ProgramData\${n}Stage", "C:\${n}Setup", `
    "C:\Windows\Temp\$l-msi.log", "C:\Temp\$l-agent.exe"
}
```

If a folder cannot be deleted because a file is in use, restart the machine and repeat the `Remove-Item` command.

Check that nothing is left:

```powershell
Get-Service | Where-Object { $_.Name -like "*Renovatio*" -or $_.Name -like "*Auzring*" }                       # prints nothing
Get-ChildItem "C:\Program Files", "C:\ProgramData" | Where-Object { $_.Name -like "*Renovatio*" -or $_.Name -like "*Auzring*" }   # prints nothing
schtasks /Query /TN "\Renovatio\rollback-check"                              # "cannot find the file specified"
```

Optional: the old device key stays in the Windows key store (harmless; a new agent uses a different key name). To list and delete it:

```powershell
certutil -csp "Microsoft Software Key Storage Provider" -key | Select-String "Renovatio|Auzring"
# for each name shown:  certutil -csp "Microsoft Software Key Storage Provider" -delkey "<name>"
# a key in the TPM is listed with: certutil -csp "Microsoft Platform Crypto Provider" -key
```
<!-- old-names:end -->

### 1.2 Remove the old server and Docker data (server machine)

**If you want to remove only the old stack**, from the old project folder (PowerShell or Ubuntu):

<!-- old-names:begin -->
```bash
docker compose -f deploy/docker-compose.yml down -v --remove-orphans
# if the old folder is already gone (the project was called renovatio, earlier auzring):
docker compose -p renovatio down -v --remove-orphans
docker rmi renovatio/server:dev
docker compose -p auzring down -v --remove-orphans
docker rmi auzring/server:dev
```
<!-- old-names:end -->

**If you want to remove all of Docker's data** (every container, image, volume and network of every project, not just this one):

```bash
docker system prune -a --volumes -f
docker volume ls          # should be empty
docker ps -a              # should be empty
```

For a complete reset of Docker Desktop itself: Docker Desktop → Settings (gear) → Troubleshoot → **Clean / Purge data** (or uninstall Docker Desktop and delete `%LOCALAPPDATA%\Docker` and `%APPDATA%\Docker`).

Then delete the old project folder, wherever it lives (a Windows folder, or inside Ubuntu: `rm -rf ~/<old folder>`), and any old ZIP downloads and extracted copies. Delete the old `deploy\secrets` and `deploy\.env` with them: they contain database and role names that no longer exist.

### 1.3 Other leftovers on the server machine and on the machines you browse from

<!-- old-names:begin -->
1. **The hosts file.** Open Notepad **as Administrator**, open `C:\Windows\System32\drivers\etc\hosts` (set the file filter to "All files") and delete every line that mentions `auzring` (for example `192.168.1.10 auzring.lab`). Save.
2. **The old Caddy certificate authority** that you imported into Windows so that the browser trusted the console. In PowerShell as Administrator:
   ```powershell
   Get-ChildItem Cert:\LocalMachine\Root, Cert:\CurrentUser\Root | Where-Object Subject -like "*Caddy Local Authority*" |
     ForEach-Object { "Removing $($_.Subject)"; Remove-Item $_.PSPath }
   ```
   (A prompt may ask you to confirm removal of the user-store certificate. Firefox keeps its own list: Settings → Privacy & Security → View Certificates → Authorities.)
3. **Firewall rules** you added for the old stack: `Get-NetFirewallRule | Where-Object DisplayName -like "*Auzring*" | Remove-NetFirewallRule`.
4. **The authenticator app on your phone:** delete the old "Auzring" entry. The new installation creates a new "Current" entry.
5. **The browser:** clear the site data (cookies) for the old host name, or the old sign-in cookie can confuse the new console.
<!-- old-names:end -->

---

## Part 2: Prepare the server machine

Windows 11 (Home or Pro), 8 GB RAM or more, virtualization enabled in the BIOS/UEFI.

1. **WSL 2 with Ubuntu.** PowerShell as Administrator:
   ```powershell
   wsl --install -d Ubuntu
   ```
   Restart if asked, start "Ubuntu" from the Start menu and create a Linux user name and password.
2. **Docker Desktop** from docker.com (use the WSL 2 backend, which is the default). In Docker Desktop → Settings → Resources → **WSL integration**, switch on "Ubuntu" and apply.
3. **Check, inside Ubuntu:**
   ```bash
   docker version        # shows a Client and a Server section
   docker compose version
   sudo apt update && sudo apt install -y unzip openssl
   ```
4. **An authenticator app** on your phone (Microsoft Authenticator, Google Authenticator, 1Password, ...).
5. **Ports.** The console uses 80 and 443, the agents use 8443. Check that nothing else holds them (PowerShell): `netstat -ano | findstr ":443 :80 :8443"`. Windows features such as IIS ("World Wide Web Publishing Service") or other web servers must be stopped, or use other ports (see Troubleshooting).

---

## Part 3: Build and start the server

### 3.1 Get the code into Ubuntu

Download the ZIP of the repository from GitHub (the main branch → Code → Download ZIP) and extract it into **a new, empty location**. Never extract over an older copy. In Ubuntu, replace `YOURNAME` with your Windows user name:

```bash
cd ~
unzip /mnt/c/Users/YOURNAME/Downloads/Current-main.zip
cd Current-main                  # use the exact folder name that the ZIP created
```

Keep the project **inside Ubuntu** (`~/...`), not under `/mnt/c/...`. Files on the Windows drive lose their Linux permissions, and the secrets directory needs them.

### 3.2 Choose the server name and put it in the hosts file

The examples use `current.lab`. Pick any name (it does not have to exist in DNS). On the server machine, PowerShell as Administrator:

```powershell
Add-Content -Path C:\Windows\System32\drivers\etc\hosts -Value "127.0.0.1 current.lab"
```

Every **other** machine that should open the console or run an agent needs the same line in its own hosts file, but with the **server machine's LAN IP** instead of `127.0.0.1` (find it with `ipconfig` on the server machine). A VM on the same PC also uses the server machine's LAN IP, not 127.0.0.1.

### 3.3 Create the secrets and the settings

In Ubuntu, in the project folder:

```bash
./scripts/init-secrets.sh                     # creates deploy/secrets/ with random passwords and the master key
cp deploy/.env.example deploy/.env
sed -i 's/^CURRENT_HOSTNAME=.*/CURRENT_HOSTNAME=current.lab/' deploy/.env
```

Leave `CURRENT_CADDY_TLS=internal` for a lab. If agents will reach the server by IP address instead of the name, also set `CURRENT_GATEWAY_SANS=<the IP>` in `deploy/.env`.

✅ `ls -ld deploy/secrets` shows `drwx------` and `ls deploy/secrets` lists six files.

### 3.4 Start the stack

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml ps -a
```

The first build downloads images and compiles the server and the web console; it takes several minutes.

✅ `server`, `caddy` and `postgres` show `running`/`healthy`, and `maintenance` shows `Exited (0)` (it runs the database migrations once; that is normal).

### 3.5 Read the setup token and trust the lab certificate

```bash
docker compose -f deploy/docker-compose.yml logs server | grep -A2 "setup token"
mkdir -p /mnt/c/Temp
docker compose -f deploy/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt /mnt/c/Temp/caddy-root.crt
```

Then PowerShell as Administrator:

```powershell
certutil -addstore -f ROOT C:\Temp\caddy-root.crt
```

This makes Edge and Chrome trust the console (Firefox needs the file imported in its own certificate settings). Caution: this root can vouch for any web site on this machine. Use it for the lab only, and remove it when you decommission the lab.

### 3.6 Open the firewall (only if other machines connect)

PowerShell as Administrator on the server machine:

```powershell
New-NetFirewallRule -DisplayName "Current console" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Current agent gateway" -Direction Inbound -Protocol TCP -LocalPort 8443 -Action Allow -Profile Private
```

If the network is classed as "Public", change the network profile to Private (Settings → Network & internet → your connection) or use `-Profile Any`.

### 3.7 First-run setup in the browser

1. Open `https://current.lab`. You are sent to **Set up Current**.
2. Paste the setup token and your email. (A wrong token is rejected: that is expected.)
3. Fill in the organization name, your name and a password of at least 12 characters (common and breached passwords are refused).
4. Enter a **CA root passphrase** of at least 16 characters. **Write it down offline.** The server never stores it.
5. Scan the QR code with your authenticator app and enter the 6-digit code.
6. Save the **recovery codes**, tick the box and continue to sign in.
7. Sign in with email, password and a fresh authenticator code. ✅ You land on **Devices**, showing "No devices yet".

---

## Part 4: Build and install the agent

### 4.1 Build the agent program (no Go installation needed)

In Ubuntu, in the project folder. This compiles the Windows executable inside a throw-away Docker container:

```bash
docker run --rm -v "$PWD":/src -w /src \
  -e CGO_ENABLED=0 -e GOOS=windows -e GOARCH=amd64 \
  golang:1.27-alpine \
  go build -trimpath -ldflags "-s -w" -o /src/current-agent.exe ./cmd/current-agent
ls -l current-agent.exe            # about 15 MB
cp current-agent.exe /mnt/c/Temp/
```

(The first run downloads the Go modules and may fetch the Go 1.27.1 toolchain; it needs internet access.)

For another machine or VM, copy `C:\Temp\current-agent.exe` to it (shared folder, USB stick or network share).

### 4.2 Create the enrollment command

In the console: **Enrollment → New token**. Name `lab`, maximum uses `5`, valid for `24` hours, **approval on**. Click **Create** and copy the install command. It is shown only once and looks like this:

```
current-agent.exe install --server current.lab:8443 --token CUR1.eyJ...
```

### 4.3 Install on each agent machine (PowerShell as Administrator)

```powershell
cd C:\Temp
Unblock-File .\current-agent.exe              # removes the "downloaded file" mark; the program is not code-signed yet
.\current-agent.exe install --server current.lab:8443 --token CUR1.eyJ...
```

✅ The output ends with "Enrolled; waiting for an administrator to approve device ...". The agent machine must resolve `current.lab` (hosts file, step 3.2) and reach port 8443 on the server machine.

### 4.4 Approve the device

In the console, **Devices**: ✅ the machine appears without refreshing, status **pending**. Open it and click **Approve**. Within about a minute it is **active** and **online**, with hardware inventory.

### 4.5 Check the agent on the machine

```powershell
Get-Service CurrentAgent                                                    # Running, display name "Current Agent"
& "C:\Program Files\Current\Agent\slot-a\current-agent.exe" status        # state: connected
Get-Content C:\ProgramData\Current\logs\agent.log -Tail 20
```

✅ The names you see are all Current: service `CurrentAgent`, folders `C:\Program Files\Current` and `C:\ProgramData\Current`. The file properties of `current-agent.exe` show company "The Current contributors" (the vendor) and product "Current".

---

## Part 5: Back up what cannot be recreated

Do this now, before you put anything of value on the server.

1. Copy the whole `deploy/secrets/` folder (above all `master_key`) and `deploy/.env` to a safe place **other than the server machine**. Without `master_key` the encrypted keys in the database cannot be read.
2. Keep the **CA root passphrase** and the **recovery codes** offline.
3. Database backups with `maintenance backup` are described in `docs/RUNBOOK.md`, section 6.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| `docker compose ... up` says a port is already in use | Something else uses 80, 443 or 8443 (`netstat -ano \| findstr :443`; common: IIS, other web servers, VPN software). Stop it, or add `CURRENT_HTTP_PORT=8080`, `CURRENT_HTTPS_PORT=8444` and `CURRENT_PUBLIC_PORT_SUFFIX=:8444` to `deploy/.env`, and use `https://current.lab:8444`. |
| `./scripts/init-secrets.sh: No such file` or `bad interpreter` | The ZIP was extracted by a tool that changed line endings, or you are in PowerShell. Run it inside Ubuntu; if the error mentions `\r`, extract the ZIP again with `unzip` in Ubuntu. |
| Browser shows a certificate warning for the console | The Caddy root was not imported (step 3.5), or you opened the page by IP instead of `current.lab`. |
| Console says "Cross-origin request rejected" | The address in the browser must be exactly `https://<CURRENT_HOSTNAME>` (plus the port suffix, if you changed the port). |
| The agent install says it cannot connect / "chain does not match the pinned root" | The agent machine cannot resolve `current.lab` to the server machine (hosts file), port 8443 is blocked (firewall), or a security product intercepts TLS on 8443. |
| The agent connects but the server log says the name is not in the certificate | You enrolled using an IP or another name. Use the name from the install command, or add the IP to `CURRENT_GATEWAY_SANS` and recreate the server (`docker compose ... up -d server`). |
| The server container keeps restarting | `docker compose -f deploy/docker-compose.yml logs server`. A password or database-name error means old secrets were reused with the new build: stop the stack, run `docker compose ... down -v`, delete `deploy/secrets`, run `./scripts/init-secrets.sh` again and start again. |
| Docker is very slow or runs out of disk | Docker Desktop → Settings → Resources; WSL 2 keeps its disk in a `.vhdx` file that you can shrink after pruning. |
| You lost the master key | Without it the data cannot be decrypted: repeat Parts 1–3 for a fresh server and enroll the machines again. |

## Removing everything again later

- **Agent:** `& "C:\Program Files\Current\Agent\slot-a\current-agent.exe" uninstall` (elevated PowerShell), then revoke or delete the device in the console. If it was installed from the MSI, uninstall it from Apps instead.
- **Server:** `docker compose -f deploy/docker-compose.yml down -v` deletes the stack and **all its data**; then delete the project folder and remove the Caddy root certificate from Windows (`Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like "*Caddy Local Authority*" | Remove-Item`).

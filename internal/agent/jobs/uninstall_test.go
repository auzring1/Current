package jobs

import (
	"errors"
	"strings"
	"testing"
	"time"

	agentv1 "github.com/auzring1/auzring/gen/proto/auzring/agent/v1"
)

const (
	uninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
	code1        = "{11111111-2222-3333-4444-555555555555}"
)

func (r *rig) uninstallEnv(id string, mut func(*agentv1.JobEnvelope, *agentv1.UninstallBody)) (*agentv1.SignedEnvelope, *agentv1.JobEnvelope) {
	body := &agentv1.UninstallBody{PackageId: "Acme.Tool", Name: "Acme Tool", Scope: agentv1.InstallScope_INSTALL_SCOPE_MACHINE,
		ItemSource: "reg64", ItemKey: "AcmeTool", Method: agentv1.UninstallMethod_UNINSTALL_METHOD_AUTO}
	env := &agentv1.JobEnvelope{Version: 1, JobId: id, OrgId: "o", DeviceId: "d", Type: agentv1.JobType_JOB_TYPE_SOFTWARE_UNINSTALL,
		IssuedAt: r.now.Unix(), NotBefore: r.now.Unix(), ExpiresAt: r.now.Add(24 * time.Hour).Unix(), Nonce: make([]byte, 16),
		Body: &agentv1.JobEnvelope_Uninstall{Uninstall: body}}
	if mut != nil {
		mut(env, body)
	}
	return r.sign(env), env
}

func (r *rig) addProgram(key string, vals map[string]string, dw map[string]uint32) {
	k := r.p.machine.add(uninstallKey + `\` + key)
	for n, v := range vals {
		k.vals[n] = v
	}
	for n, v := range dw {
		k.dw[n] = v
	}
}

// removesKeyOnRun makes the fake uninstaller delete the program's Uninstall key.
func (r *rig) removesKeyOnRun(key string, exit int) {
	r.p.runFn = func(RunSpec, string) (RunResult, error) {
		if exit == 0 {
			r.p.machine.add(uninstallKey).remove(key)
		}
		return RunResult{ExitCode: exit}, nil
	}
}

func TestUninstallByProductCode(t *testing.T) {
	r := newRig(t)
	r.addProgram(code1, map[string]string{"DisplayName": "Acme", "UninstallString": "MsiExec.exe /X" + code1}, map[string]uint32{"WindowsInstaller": 1})
	r.removesKeyOnRun(code1, 0)
	se, env := r.uninstallEnv("u1", func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ItemKey = code1 })
	r.e.Accept(se, env)
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_SUCCEEDED || len(r.p.runs) != 1 {
		t.Fatalf("%v %+v", r.state("u1"), r.rec.last("u1"))
	}
	run := r.p.runs[0]
	if !strings.HasSuffix(run.Exe, "msiexec.exe") || run.Args[0] != "/x" || run.Args[1] != code1 || !contains(run.Args, "/qn") {
		t.Fatalf("command: %v %v", run.Exe, run.Args)
	}
}

func TestUninstallUsesQuietStringThenInnoSwitches(t *testing.T) {
	r := newRig(t)
	r.addProgram("AcmeTool", map[string]string{"QuietUninstallString": `"C:\Program Files\Acme\remove.exe" --quiet`}, nil)
	r.removesKeyOnRun("AcmeTool", 0)
	se, env := r.uninstallEnv("u1", nil)
	r.e.Accept(se, env)
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_SUCCEEDED || r.p.runs[0].Exe != `C:\Program Files\Acme\remove.exe` || r.p.runs[0].Args[0] != "--quiet" {
		t.Fatalf("%v %+v", r.state("u1"), r.p.runs)
	}
	r2 := newRig(t)
	r2.addProgram("Inno", map[string]string{"UninstallString": `"C:\Program Files\Inno\unins000.exe"`}, nil)
	r2.removesKeyOnRun("Inno", 0)
	se, env = r2.uninstallEnv("u2", func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ItemKey = "Inno" })
	r2.e.Accept(se, env)
	r2.tick()
	if r2.state("u2") != agentv1.JobState_JOB_STATE_SUCCEEDED || !contains(r2.p.runs[0].Args, "/VERYSILENT") {
		t.Fatalf("%v %+v", r2.state("u2"), r2.p.runs)
	}
}

func TestUninstallWithoutSilentCommandFailsClosed(t *testing.T) {
	r := newRig(t)
	r.addProgram("AcmeTool", map[string]string{"UninstallString": `"C:\Program Files\Acme\uninst.exe"`}, nil)
	se, env := r.uninstallEnv("u1", nil)
	r.e.Accept(se, env)
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_FAILED || len(r.p.runs) != 0 || !strings.Contains(r.rec.last("u1").Result.Message, "silent") {
		t.Fatalf("%v %+v", r.state("u1"), r.rec.last("u1").Result)
	}
	// An administrator can supply validated silent switches.
	se, env = r.uninstallEnv("u2", func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ExtraArgs = []string{"/S"} })
	r.removesKeyOnRun("AcmeTool", 0)
	r.e.Accept(se, env)
	r.tick()
	if r.state("u2") != agentv1.JobState_JOB_STATE_SUCCEEDED || r.p.runs[0].Args[0] != "/S" {
		t.Fatalf("%v", r.state("u2"))
	}
}

func TestUntrustedUninstallerIsNotRunAsService(t *testing.T) {
	r := newRig(t)
	r.addProgram("AcmeTool", map[string]string{"QuietUninstallString": `C:\Users\Public\evil.exe /S`}, nil)
	r.p.trusted = func(p string) error { return errors.New("located in a user-writable folder") }
	se, env := r.uninstallEnv("u1", nil)
	r.e.Accept(se, env)
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_FAILED || len(r.p.runs) != 0 {
		t.Fatalf("%v runs=%d", r.state("u1"), len(r.p.runs))
	}
}

func TestUninstallRelativePathRefused(t *testing.T) {
	r := newRig(t)
	r.addProgram("AcmeTool", map[string]string{"QuietUninstallString": `uninstall.exe /S`}, nil)
	se, env := r.uninstallEnv("u1", nil)
	r.e.Accept(se, env)
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_FAILED || len(r.p.runs) != 0 {
		t.Fatalf("%v", r.state("u1"))
	}
}

func TestUninstallAlreadyGoneAndStillListed(t *testing.T) {
	r := newRig(t)
	se, env := r.uninstallEnv("u1", nil)
	r.e.Accept(se, env)
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_SUCCEEDED || !r.rec.last("u1").Result.AlreadySatisfied {
		t.Fatalf("absent program: %v", r.state("u1"))
	}
	r.addProgram("AcmeTool", map[string]string{"QuietUninstallString": `"C:\Program Files\A\u.exe" /S`}, nil)
	r.p.runFn = func(RunSpec, string) (RunResult, error) { return RunResult{ExitCode: 0}, nil } // claims success, removes nothing
	se, env = r.uninstallEnv("u2", nil)
	r.e.Accept(se, env)
	r.tick()
	if r.state("u2") != agentv1.JobState_JOB_STATE_FAILED || r.rec.last("u2").Reason != "failed_detection" {
		t.Fatalf("%v %q", r.state("u2"), r.rec.last("u2").Reason)
	}
}

func TestUserScopeUninstallRunsInUserContext(t *testing.T) {
	r := newRig(t)
	const sid = "S-1-5-21-1-2-3-1001"
	k := r.p.userRoot(sid).add(`Software\Microsoft\Windows\CurrentVersion\Uninstall\Tool`)
	k.vals["QuietUninstallString"] = `"C:\Users\a\AppData\Local\Tool\unins000.exe" /VERYSILENT`
	var ranAs string
	r.p.runFn = func(RunSpec, string) (RunResult, error) {
		ranAs = sid
		r.p.userRoot(sid).add(`Software\Microsoft\Windows\CurrentVersion\Uninstall`).remove("Tool")
		return RunResult{}, nil
	}
	se, env := r.uninstallEnv("u1", func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) {
		e.TargetUserSid, b.Scope, b.ItemSource, b.ItemKey = sid, agentv1.InstallScope_INSTALL_SCOPE_USER, "hku", "Tool"
	})
	r.e.Accept(se, env)
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_WAITING || len(r.p.runs) != 0 {
		t.Fatalf("must wait for the user: %v", r.state("u1"))
	}
	r.p.sessions[sid] = true
	r.tick()
	if r.state("u1") != agentv1.JobState_JOB_STATE_SUCCEEDED || ranAs != sid {
		t.Fatalf("%v ranAs=%q", r.state("u1"), ranAs)
	}
}

func TestUninstallBodyValidation(t *testing.T) {
	r := newRig(t)
	bad := map[string]func(*agentv1.JobEnvelope, *agentv1.UninstallBody){
		"unknown source":  func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ItemSource = "weird" },
		"hku for machine": func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ItemSource = "hku" },
		"bad guid":        func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ProductCode = "{nope}" },
		"msi non guid":    func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ItemSource, b.ItemKey = "msi", "AcmeTool" },
		"evil extra":      func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ExtraArgs = []string{"/S|calc"} },
		"empty key":       func(e *agentv1.JobEnvelope, b *agentv1.UninstallBody) { b.ItemKey = "" },
	}
	i := 0
	for name, mut := range bad {
		i++
		id := "x" + string(rune('a'+i))
		se, env := r.uninstallEnv(id, mut)
		r.e.Accept(se, env)
		if r.state(id) != agentv1.JobState_JOB_STATE_REJECTED {
			t.Errorf("%s: %v", name, r.state(id))
		}
	}
}

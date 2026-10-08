//go:build windows

package wu

import (
	"fmt"

	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc/mgr"

	agentv1 "github.com/auzring1/renovatio/gen/proto/auzring/agent/v1"
)

const (
	wuPolicyKey = `SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate`
	auPolicyKey = wuPolicyKey + `\AU`
	mdmUpdate   = `SOFTWARE\Microsoft\PolicyManager\current\device\Update`
)

func hklm(path string) (registry.Key, bool) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	return k, err == nil
}

func dword(path, name string) (uint32, bool) {
	k, ok := hklm(path)
	if !ok {
		return 0, false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue(name)
	return uint32(v), err == nil // #nosec G115 -- DWORD
}

func text(path, name string) string {
	k, ok := hklm(path)
	if !ok {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	return v
}

// Policy reads the policies that decide who manages Windows Update on this machine.
func (c *wuaClient) Policy() *agentv1.WuPolicyInfo {
	p := &agentv1.WuPolicyInfo{EffectiveSource: "windows_update"}
	if v, ok := dword(auPolicyKey, "UseWUServer"); ok && v == 1 {
		p.WsusConfigured = true
		p.WsusServer = bound(text(wuPolicyKey, "WUServer"), 256)
		p.EffectiveSource = "wsus"
		p.Notes = append(p.Notes, "A WSUS server is configured by policy; Windows Update on the internet is not used unless a policy allows it.")
	}
	if v, ok := dword(auPolicyKey, "NoAutoUpdate"); ok && v == 1 {
		p.NoAutoUpdate = true
		p.Notes = append(p.Notes, `"Configure Automatic Updates" is disabled by policy.`)
	}
	if v, ok := dword(auPolicyKey, "AUOptions"); ok {
		p.AuOptions = v
	}
	for _, n := range []string{"DeferQualityUpdates", "DeferFeatureUpdates", "PauseQualityUpdates", "PauseFeatureUpdates", "DeferQualityUpdatesPeriodInDays", "DeferFeatureUpdatesPeriodInDays"} {
		if v, ok := dword(wuPolicyKey, n); ok && v != 0 {
			p.WufbDeferrals = true
		}
	}
	for _, n := range []string{"DeferQualityUpdatesPeriodInDays", "DeferFeatureUpdatesPeriodInDays", "PauseQualityUpdates", "PauseFeatureUpdates"} {
		if v, ok := dword(mdmUpdate, n); ok && v != 0 {
			p.WufbDeferrals = true
		}
	}
	if p.WufbDeferrals {
		p.Notes = append(p.Notes, "Windows Update for Business deferral or pause policies are set (Intune or Group Policy).")
	}
	if v, ok := dword(wuPolicyKey, "SetActiveHours"); ok && v == 1 {
		p.ActiveHoursPolicy = true
	}
	if m, err := mgr.Connect(); err == nil {
		defer m.Disconnect()
		if s, err := m.OpenService("wuauserv"); err == nil {
			defer s.Close()
			if cfg, err := s.Config(); err == nil && cfg.StartType == mgr.StartDisabled {
				p.WuServiceDisabled = true
				p.Notes = append(p.Notes, "The Windows Update service (wuauserv) is disabled.")
			}
		}
	}
	return p
}

// String is only used in logs.
func (c *wuaClient) String() string { return fmt.Sprintf("wua(%s)", "com") }

// PendingReboot reports the standard markers that Windows needs a restart: Windows Update, the
// component store, and pending file renames.
func PendingReboot() bool {
	for _, p := range []string{
		`SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`,
		`SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`,
	} {
		if k, ok := hklm(p); ok {
			_ = k.Close()
			return true
		}
	}
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\Session Manager`, registry.QUERY_VALUE); err == nil {
		defer k.Close()
		if v, _, err := k.GetStringsValue("PendingFileRenameOperations"); err == nil && len(v) > 0 {
			return true
		}
	}
	return false
}

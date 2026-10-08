package main

import (
	"crypto/ed25519"
	"os"
	"path/filepath"
	"testing"

	"github.com/auzring1/auzring/internal/shared/license"
)

// TestKMSFlow: payload -> external Ed25519 signature over the .tosign bytes -> attach -> verify.
func TestKMSFlow(t *testing.T) {
	dir := t.TempDir()
	p := func(n string) string { return filepath.Join(dir, n) }
	if err := keygen([]string{"--out", p("l.key")}); err != nil {
		t.Fatal(err)
	}
	if err := keygen([]string{"--out", p("l.key")}); err == nil {
		t.Fatal("keygen must refuse to overwrite a key")
	}
	if err := payload([]string{"--licensee", "Acme", "--max-devices", "7", "--expires", "2099-01-01", "--out", p("d.json"), "--tosign", p("d.tosign")}); err != nil {
		t.Fatal(err)
	}
	priv, err := readKey(p("l.key"))
	if err != nil {
		t.Fatal(err)
	}
	tosign, _ := os.ReadFile(p("d.tosign"))
	if string(tosign[:len(license.Domain)]) != license.Domain {
		t.Fatal("the bytes to sign must start with the license domain separator")
	}
	if err := os.WriteFile(p("sig.bin"), ed25519.Sign(priv, tosign), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := attach([]string{"--doc", p("d.json"), "--signature", p("sig.bin"), "--pub", p("l.pub"), "--out", p("lic.txt")}); err != nil {
		t.Fatal(err)
	}
	if err := verify([]string{"--license", p("lic.txt"), "--pub", p("l.pub")}); err != nil {
		t.Fatal(err)
	}
	// A signature over the document without the separator must not attach.
	b, _ := os.ReadFile(p("d.json"))
	if err := os.WriteFile(p("bad.bin"), ed25519.Sign(priv, b), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := attach([]string{"--doc", p("d.json"), "--signature", p("bad.bin"), "--pub", p("l.pub"), "--out", p("x.txt")}); err == nil {
		t.Fatal("a signature without the domain separator was attached")
	}
	if err := sign([]string{"--key", p("l.key"), "--licensee", "A", "--max-devices", "0", "--out", p("y.txt")}); err == nil {
		t.Fatal("max-devices 0 accepted")
	}
}

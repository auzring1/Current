// Command auzring-release is the vendor-side tool that creates and checks signed agent releases.
//
//	auzring-release keygen --out release.key            create an Ed25519 release key pair (writes release.key and release.pub)
//	auzring-release sign --key release.key --exe agent.exe --version 1.2.3 [--os windows --arch amd64]
//	                     [--min-version V] [--rollback-from V,...] [--authenticode-subject CN] [--notes TEXT] --out agent-1.2.3.azr
//	auzring-release manifest --exe agent.exe --version 1.2.3 ... --out manifest.json     (for an HSM/KMS signer)
//	auzring-release attach --manifest manifest.json --signature sig.bin --key-id ID --out agent-1.2.3.azr
//	auzring-release verify --bundle agent-1.2.3.azr --exe agent.exe --pub release.pub
//
// The private key never leaves the signer: with a cloud KMS use `manifest`, sign the bytes
// with "auzring/release/v1\x00" prepended, then `attach`. This tool is not part of the shipped
// product; it runs in the vendor's release pipeline (docs/RUNBOOK.md, release signing).
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/auzring1/auzring/internal/shared/release"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = keygen(os.Args[2:])
	case "sign":
		err = sign(os.Args[2:])
	case "manifest":
		err = manifestCmd(os.Args[2:])
	case "attach":
		err = attach(os.Args[2:])
	case "verify":
		err = verify(os.Args[2:])
	default:
		usage()
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, "usage: auzring-release keygen|sign|manifest|attach|verify (see the package comment)\n")
}

func keygen(args []string) error {
	fl := flag.NewFlagSet("keygen", flag.ContinueOnError)
	out := fl.String("out", "release.key", "private key file (the public key is written next to it as .pub)")
	if err := fl.Parse(args); err != nil {
		return err
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err := writeNew(*out, []byte(hex.EncodeToString(priv.Seed())+"\n"), 0o600); err != nil {
		return err
	}
	pubPath := strings.TrimSuffix(*out, ".key") + ".pub"
	if err := writeNew(pubPath, []byte(hex.EncodeToString(pub)+"\n"), 0o644); err != nil { // #nosec G306 -- public key
		return err
	}
	fmt.Printf("private key: %s (keep it offline or in a KMS)\npublic key:  %s\nkey id:      %s\npublic key hex (for -ldflags): %s\n", *out, pubPath, release.KeyID(pub), hex.EncodeToString(pub))
	return nil
}

// writeNew creates a file and refuses to overwrite an existing one (a key must never be replaced silently).
func writeNew(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode) // #nosec G304 -- operator-chosen output path
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

type common struct {
	exe, version, goos, goarch, minV, rollback, subject, notes string
}

func (c *common) flags(fl *flag.FlagSet) {
	fl.StringVar(&c.exe, "exe", "", "the agent binary")
	fl.StringVar(&c.version, "version", "", "its version (must equal the -X Version the binary was built with)")
	fl.StringVar(&c.goos, "os", "windows", "operating system")
	fl.StringVar(&c.goarch, "arch", "amd64", "architecture")
	fl.StringVar(&c.minV, "min-version", "", "oldest agent version allowed to update directly")
	fl.StringVar(&c.rollback, "rollback-from", "", "comma-separated versions from which this older release may be installed")
	fl.StringVar(&c.subject, "authenticode-subject", "", "certificate subject the binary must be Authenticode-signed with")
	fl.StringVar(&c.notes, "notes", "", "release notes (short)")
}

func (c *common) manifest() ([]byte, error) {
	if c.exe == "" || c.version == "" {
		return nil, errors.New("--exe and --version are required")
	}
	f, err := os.Open(c.exe) // #nosec G304 -- operator-chosen path
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return nil, err
	}
	m := &release.Manifest{Format: 1, Product: release.Product, Version: c.version, OS: c.goos, Arch: c.goarch,
		SHA256: hex.EncodeToString(h.Sum(nil)), Size: uint64(n), ReleasedAt: time.Now().Unix(), // #nosec G115 -- non-negative
		MinVersion: c.minV, AuthenticodeSubject: c.subject, Notes: c.notes}
	for _, v := range strings.Split(c.rollback, ",") {
		if v = strings.TrimSpace(v); v != "" {
			m.RollbackFrom = append(m.RollbackFrom, v)
		}
	}
	return release.Marshal(m)
}

func readKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path) // #nosec G304 -- operator-chosen path
	if err != nil {
		return nil, err
	}
	seed, err := hex.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("the key file must hold a 32-byte Ed25519 seed in hex")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func sign(args []string) error {
	fl := flag.NewFlagSet("sign", flag.ContinueOnError)
	var c common
	c.flags(fl)
	keyPath := fl.String("key", "", "private key file")
	out := fl.String("out", "", "bundle to write (.azr)")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if *keyPath == "" || *out == "" {
		return errors.New("--key and --out are required")
	}
	priv, err := readKey(*keyPath)
	if err != nil {
		return err
	}
	mb, err := c.manifest()
	if err != nil {
		return err
	}
	pub := priv.Public().(ed25519.PublicKey)
	return writeBundle(*out, mb, release.Sign(priv, mb), release.KeyID(pub))
}

func manifestCmd(args []string) error {
	fl := flag.NewFlagSet("manifest", flag.ContinueOnError)
	var c common
	c.flags(fl)
	out := fl.String("out", "manifest.json", "manifest file to write")
	if err := fl.Parse(args); err != nil {
		return err
	}
	mb, err := c.manifest()
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, mb, 0o644); err != nil { // #nosec G306 -- not secret
		return err
	}
	fmt.Printf("wrote %s; sign the bytes of this file after prepending %q, then run `attach`\n", *out, release.Domain)
	return nil
}

func attach(args []string) error {
	fl := flag.NewFlagSet("attach", flag.ContinueOnError)
	mf := fl.String("manifest", "", "manifest file")
	sf := fl.String("signature", "", "raw 64-byte Ed25519 signature file")
	keyID := fl.String("key-id", "", "key id (hex) of the signing key")
	out := fl.String("out", "", "bundle to write (.azr)")
	if err := fl.Parse(args); err != nil {
		return err
	}
	mb, err := os.ReadFile(*mf) // #nosec G304 -- operator-chosen path
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(*sf) // #nosec G304 -- operator-chosen path
	if err != nil {
		return err
	}
	return writeBundle(*out, mb, sig, *keyID)
}

func writeBundle(path string, manifest, sig []byte, keyID string) error {
	b, err := release.EncodeBundle(&release.Bundle{Manifest: manifest, Signature: sig, KeyID: keyID})
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, b, 0o644); err != nil { // #nosec G306 -- not secret
		return err
	}
	fmt.Println("wrote", path)
	return nil
}

func verify(args []string) error {
	fl := flag.NewFlagSet("verify", flag.ContinueOnError)
	bp := fl.String("bundle", "", "bundle (.azr)")
	exe := fl.String("exe", "", "binary to check against the manifest (optional)")
	pubf := fl.String("pub", "", "public key file (hex)")
	if err := fl.Parse(args); err != nil {
		return err
	}
	data, err := os.ReadFile(*bp) // #nosec G304 -- operator-chosen path
	if err != nil {
		return err
	}
	b, err := release.DecodeBundle(data)
	if err != nil {
		return err
	}
	pb, err := os.ReadFile(*pubf) // #nosec G304 -- operator-chosen path
	if err != nil {
		return err
	}
	keys, err := release.ParseKeys(string(pb))
	if err != nil {
		return err
	}
	m, err := release.Verify(keys, b.Manifest, b.Signature, b.KeyID)
	if err != nil {
		return err
	}
	if *exe != "" {
		f, err := os.Open(*exe) // #nosec G304 -- operator-chosen path
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		h := sha256.New()
		n, err := io.Copy(h, f)
		if err != nil {
			return err
		}
		if hex.EncodeToString(h.Sum(nil)) != m.SHA256 || uint64(n) != m.Size { // #nosec G115 -- non-negative
			return errors.New("the binary does not match the manifest")
		}
	}
	fmt.Printf("OK: %s %s %s/%s sha256 %s\n", release.Product, m.Version, m.OS, m.Arch, m.SHA256)
	return nil
}

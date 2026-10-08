// Command renovatio-license is the vendor-side tool that creates and checks Renovatio license keys.
//
//	renovatio-license keygen --out license.key             create an Ed25519 license key pair (license.key, license.pub)
//	renovatio-license sign --key license.key --licensee "Example GmbH" --max-devices 250
//	                     [--license-id ID] [--features a,b] [--not-before DATE] [--expires DATE]
//	                     [--updates-until DATE] [--notes TEXT] [--out license.txt]
//	renovatio-license payload <same flags as sign> --out doc.json --tosign doc.tosign   (for a KMS/HSM signer)
//	renovatio-license attach --doc doc.json --signature sig.bin [--pub license.pub] [--out license.txt]
//	renovatio-license verify --license license.txt (--pub license.pub | --pub-hex HEX)
//	renovatio-license show --license license.txt [--pub license.pub]
//
// DATE is YYYY-MM-DD (UTC) or RFC 3339. A license file holds one line, RNL1.<document>.<signature>.
//
// The private key never leaves the signer. With a cloud KMS use `payload`, sign the contents of the
// .tosign file (it already starts with the domain separator "renovatio/license/v1\x00") with Ed25519,
// then run `attach`. The license key is NOT the release key: never use one for the other; the
// signatures are domain-separated, so a mix-up fails verification instead of silently working.
//
// This tool is not part of the shipped product; it runs on the vendor's signing workstation
// (docs/RUNBOOK.md, issuing licenses).
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/auzring1/renovatio/internal/shared/license"
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
	case "payload":
		err = payload(os.Args[2:])
	case "attach":
		err = attach(os.Args[2:])
	case "verify":
		err = verify(os.Args[2:])
	case "show":
		err = show(os.Args[2:])
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
	fmt.Fprint(os.Stderr, "usage: renovatio-license keygen|sign|payload|attach|verify|show (see the package comment)\n")
}

func keygen(args []string) error {
	fl := flag.NewFlagSet("keygen", flag.ContinueOnError)
	out := fl.String("out", "license.key", "private key file (the public key is written next to it as .pub)")
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
	fmt.Printf("private key: %s (keep it offline or in a KMS; never commit it)\npublic key:  %s\nkey id:      %s\n"+
		"public key hex (for -ldflags ...license.PublicKeysHex=, or RENOVATIO_LICENSE_PUBLIC_KEYS for a test server): %s\n",
		*out, pubPath, license.KeyID(pub), hex.EncodeToString(pub))
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

// readBlob reads a license from a file, or stdin for "-".
func readBlob(path string) (string, error) {
	var b []byte
	var err error
	if path == "-" {
		b, err = io.ReadAll(io.LimitReader(os.Stdin, license.MaxBlobBytes+1))
	} else {
		b, err = os.ReadFile(path) // #nosec G304 -- operator-chosen path
	}
	return string(b), err
}

func readKeys(file, hexList string) ([]ed25519.PublicKey, error) {
	list := hexList
	if file != "" {
		b, err := os.ReadFile(file) // #nosec G304 -- operator-chosen path
		if err != nil {
			return nil, err
		}
		list += "," + strings.ReplaceAll(strings.TrimSpace(string(b)), "\n", ",")
	}
	keys, err := license.ParseKeys(list)
	if err != nil {
		return nil, err
	}
	if len(keys) == 0 {
		return nil, errors.New("give the public key with --pub FILE or --pub-hex HEX")
	}
	return keys, nil
}

// fields are the license contents given on the command line.
type fields struct {
	id, licensee, features, notBefore, expires, updatesUntil, notes string
	maxDevices                                                      int
}

func (f *fields) flags(fl *flag.FlagSet) {
	fl.StringVar(&f.id, "license-id", "", "license identifier (default: random)")
	fl.StringVar(&f.licensee, "licensee", "", "who the license is issued to")
	fl.IntVar(&f.maxDevices, "max-devices", 0, "number of devices the license covers")
	fl.StringVar(&f.features, "features", "", "comma-separated feature names")
	fl.StringVar(&f.notBefore, "not-before", "", "start of validity (default: now)")
	fl.StringVar(&f.expires, "expires", "", "end of the subscription (default: the license does not expire)")
	fl.StringVar(&f.updatesUntil, "updates-until", "", "releases published after this date are not eligible (default: all)")
	fl.StringVar(&f.notes, "notes", "", "free text shown to the administrator")
}

func parseDate(s string) (int64, error) {
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.Unix(), nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0, fmt.Errorf("%q is neither YYYY-MM-DD nor RFC 3339", s)
	}
	return t.Unix(), nil
}

func (f *fields) document(now time.Time) ([]byte, error) {
	if f.licensee == "" || f.maxDevices == 0 {
		return nil, errors.New("--licensee and --max-devices are required")
	}
	id := f.id
	if id == "" {
		var r [6]byte
		if _, err := rand.Read(r[:]); err != nil {
			return nil, err
		}
		id = "LIC-" + strings.ToUpper(hex.EncodeToString(r[:]))
	}
	d := &license.Document{Format: 1, LicenseID: id, Licensee: f.licensee, IssuedAt: now.Unix(), NotBefore: now.Unix(),
		MaxDevices: f.maxDevices, Features: []string{}, Notes: f.notes}
	for _, n := range strings.Split(f.features, ",") {
		if n = strings.TrimSpace(n); n != "" {
			d.Features = append(d.Features, n)
		}
	}
	var err error
	if f.notBefore != "" {
		if d.NotBefore, err = parseDate(f.notBefore); err != nil {
			return nil, fmt.Errorf("--not-before: %w", err)
		}
	}
	if f.expires != "" {
		v, err := parseDate(f.expires)
		if err != nil {
			return nil, fmt.Errorf("--expires: %w", err)
		}
		d.ExpiresAt = &v
	}
	if f.updatesUntil != "" {
		v, err := parseDate(f.updatesUntil)
		if err != nil {
			return nil, fmt.Errorf("--updates-until: %w", err)
		}
		d.UpdatesUntil = &v
	}
	return license.Marshal(d)
}

func writeOut(path, text string, mode os.FileMode) error {
	if path == "" || path == "-" {
		fmt.Println(text)
		return nil
	}
	if err := os.WriteFile(path, []byte(text+"\n"), mode); err != nil { // #nosec G306 G703 -- operator-chosen output path; a license is not secret
		return err
	}
	fmt.Fprintln(os.Stderr, "wrote", path)
	return nil
}

func sign(args []string) error {
	fl := flag.NewFlagSet("sign", flag.ContinueOnError)
	var f fields
	f.flags(fl)
	keyPath := fl.String("key", "", "private key file")
	out := fl.String("out", "", "license file to write (default: standard output)")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if *keyPath == "" {
		return errors.New("--key is required")
	}
	priv, err := readKey(*keyPath)
	if err != nil {
		return err
	}
	doc, err := f.document(time.Now())
	if err != nil {
		return err
	}
	return writeOut(*out, license.Encode(doc, license.Sign(priv, doc)), 0o644)
}

func payload(args []string) error {
	fl := flag.NewFlagSet("payload", flag.ContinueOnError)
	var f fields
	f.flags(fl)
	out := fl.String("out", "doc.json", "document file to write")
	tosign := fl.String("tosign", "doc.tosign", "bytes to sign (domain separator + document) to write")
	if err := fl.Parse(args); err != nil {
		return err
	}
	doc, err := f.document(time.Now())
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, doc, 0o644); err != nil { // #nosec G306 -- not secret
		return err
	}
	if err := os.WriteFile(*tosign, license.SignedBytes(doc), 0o644); err != nil { // #nosec G306 -- not secret
		return err
	}
	fmt.Printf("wrote %s and %s; Ed25519-sign the whole .tosign file with the license key, then run `attach`\n", *out, *tosign)
	return nil
}

func attach(args []string) error {
	fl := flag.NewFlagSet("attach", flag.ContinueOnError)
	docf := fl.String("doc", "", "document file from `payload`")
	sigf := fl.String("signature", "", "raw 64-byte Ed25519 signature file")
	pubf := fl.String("pub", "", "public key file; when given the result is verified before it is written")
	pubHex := fl.String("pub-hex", "", "public key in hex; when given the result is verified before it is written")
	out := fl.String("out", "", "license file to write (default: standard output)")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if *docf == "" || *sigf == "" {
		return errors.New("--doc and --signature are required")
	}
	doc, err := os.ReadFile(*docf) // #nosec G304 -- operator-chosen path
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(*sigf) // #nosec G304 -- operator-chosen path
	if err != nil {
		return err
	}
	blob := license.Encode(doc, sig)
	if *pubf != "" || *pubHex != "" {
		keys, err := readKeys(*pubf, *pubHex)
		if err != nil {
			return err
		}
		if _, err := license.Verify(keys, blob); err != nil {
			return fmt.Errorf("the signature does not belong to this document and key: %w", err)
		}
	}
	return writeOut(*out, blob, 0o644)
}

func verify(args []string) error {
	fl := flag.NewFlagSet("verify", flag.ContinueOnError)
	lf := fl.String("license", "", "license file, or - for standard input")
	pubf := fl.String("pub", "", "public key file (hex)")
	pubHex := fl.String("pub-hex", "", "public key(s) in hex, comma-separated")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if *lf == "" {
		return errors.New("--license is required")
	}
	blob, err := readBlob(*lf)
	if err != nil {
		return err
	}
	keys, err := readKeys(*pubf, *pubHex)
	if err != nil {
		return err
	}
	v, err := license.Verify(keys, blob)
	if err != nil {
		return err
	}
	fmt.Printf("OK: license %s for %q, %d devices, signed by key %s\n", v.Doc.LicenseID, v.Doc.Licensee, v.Doc.MaxDevices, v.KeyID)
	return nil
}

func show(args []string) error {
	fl := flag.NewFlagSet("show", flag.ContinueOnError)
	lf := fl.String("license", "", "license file, or - for standard input")
	pubf := fl.String("pub", "", "public key file; when given the signature is checked too")
	pubHex := fl.String("pub-hex", "", "public key(s) in hex; when given the signature is checked too")
	if err := fl.Parse(args); err != nil {
		return err
	}
	if *lf == "" {
		return errors.New("--license is required")
	}
	blob, err := readBlob(*lf)
	if err != nil {
		return err
	}
	var d *license.Document
	status := "signature NOT checked (give --pub to check it)"
	if *pubf != "" || *pubHex != "" {
		keys, err := readKeys(*pubf, *pubHex)
		if err != nil {
			return err
		}
		v, err := license.Verify(keys, blob)
		if err != nil {
			return err
		}
		d, status = v.Doc, "signature OK (key "+v.KeyID+")"
	} else if d, err = license.ParseUnverified(blob); err != nil {
		return err
	}
	date := func(sec int64) string { return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04 UTC") }
	opt := func(p *int64, none string) string {
		if p == nil {
			return none
		}
		return date(*p)
	}
	fmt.Printf("license id:    %s\nlicensee:      %s\nissued:        %s\nvalid from:    %s\nexpires:       %s\nmax devices:   %d\nfeatures:      %s\nupdates until: %s\nnotes:         %s\n%s\n",
		d.LicenseID, d.Licensee, date(d.IssuedAt), date(d.NotBefore), opt(d.ExpiresAt, "never"), d.MaxDevices,
		strings.Join(d.Features, ", "), opt(d.UpdatesUntil, "no limit"), d.Notes, status)
	return nil
}

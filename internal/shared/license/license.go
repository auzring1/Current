// Package license defines the vendor-signed, offline-verifiable license document.
//
// A license is a small strict-JSON document signed with an Ed25519 vendor LICENSE key. The public half
// is compiled into the server (and may be extended with RENOVATIO_LICENSE_PUBLIC_KEYS for test and demo keys).
// Verification never contacts anybody: there is no phone-home of any kind (decision O9).
//
// The license key is a different key from the release key and signs under its own domain separator,
// so a signature made for one purpose can never be replayed for the other (docs/SECURITY.md §9g).
//
// Text form, suitable for pasting into the console or an e-mail:
//
//	RNL1.<base64url(document)>.<base64url(signature)>
package license

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Domain separates license signatures from every other Ed25519 signature in the product
// (in particular from release signatures, which use "renovatio/release/v1\x00").
const Domain = "renovatio/license/v1\x00"

// Prefix starts every license blob and names its encoding version.
const Prefix = "RNL1"

// Limits on attacker-influenced input (a license is pasted by an administrator, but is parsed with
// the same care as anything that crosses a trust boundary).
const (
	MaxDocumentBytes = 4 << 10
	MaxBlobBytes     = 16 << 10 // the text blob including any whitespace added by mail clients
	MaxNotes         = 1024
	MaxLicensee      = 200
	MaxFeatures      = 32
	MaxDevices       = 1_000_000
	// ClockSkew is how far a clock may be off before a license is judged not yet valid or expired.
	ClockSkew = 24 * time.Hour
)

// PublicKeysHex is the comma-separated list of trusted vendor license public keys (hex Ed25519).
// Release builds set it with
//
//	-ldflags "-X github.com/auzring1/renovatio/internal/shared/license.PublicKeysHex=<hex>[,<hex>]"
//
// There is no default key and no "dev" key in the tree. A build without a key reports "licensing not
// configured" and the server runs unlicensed (evaluation limits), see ErrNotConfigured.
var PublicKeysHex = ""

// ErrNotConfigured is returned when no license public key is known to this build.
var ErrNotConfigured = errors.New("licensing not configured: this build contains no vendor license key")

// Document is the signed license. Unknown fields are rejected so a newer vendor cannot smuggle
// meaning past an older server. Times are unix seconds.
type Document struct {
	Format    int    `json:"format"`
	LicenseID string `json:"license_id"`
	Licensee  string `json:"licensee"`
	IssuedAt  int64  `json:"issued_at"`
	NotBefore int64  `json:"not_before"`
	// ExpiresAt is the end of the subscription; nil means the license does not expire.
	ExpiresAt  *int64 `json:"expires_at,omitempty"`
	MaxDevices int    `json:"max_devices"`
	// Features are opaque capability names (lowercase, e.g. "reports.export"); the server only
	// reports them. Phase 6 gates nothing on them.
	Features []string `json:"features"`
	// UpdatesUntil: agent releases published after this instant are not eligible for rollout.
	UpdatesUntil *int64 `json:"updates_until,omitempty"`
	Notes        string `json:"notes,omitempty"`
}

var (
	idRe      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	featureRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

// KeyID returns the short identifier of a public key (hex of the first 8 bytes of its SHA-256).
func KeyID(pub ed25519.PublicKey) string {
	h := sha256.Sum256(pub)
	return hex.EncodeToString(h[:8])
}

// ParseKeys parses a comma-separated list of hex public keys.
func ParseKeys(list string) ([]ed25519.PublicKey, error) {
	var out []ed25519.PublicKey
	for _, p := range strings.Split(list, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		b, err := hex.DecodeString(p)
		if err != nil || len(b) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("license: %q is not an Ed25519 public key in hex", abbreviate(p))
		}
		out = append(out, ed25519.PublicKey(b))
	}
	return out, nil
}

func abbreviate(s string) string {
	if len(s) > 12 {
		return s[:12] + "..."
	}
	return s
}

// TrustedKeys returns the keys compiled into this binary (nil when none or when the build-time
// value is malformed: a bad key trusts nothing).
func TrustedKeys() []ed25519.PublicKey {
	k, err := ParseKeys(PublicKeysHex)
	if err != nil {
		return nil
	}
	return k
}

// Marshal validates a document and produces the exact bytes that are signed. The signer keeps them.
func Marshal(d *Document) ([]byte, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	b, err := json.Marshal(d)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxDocumentBytes {
		return nil, errors.New("license: document is too large")
	}
	return b, nil
}

// SignedBytes returns what the signature covers: the domain separator followed by the document bytes.
// An external signer (KMS/HSM) signs exactly these bytes.
func SignedBytes(doc []byte) []byte {
	return append([]byte(Domain), doc...)
}

// Sign signs document bytes with a vendor license key.
func Sign(priv ed25519.PrivateKey, doc []byte) []byte {
	return ed25519.Sign(priv, SignedBytes(doc))
}

// Encode produces the pasteable text form.
func Encode(doc, sig []byte) string {
	return Prefix + "." + base64.RawURLEncoding.EncodeToString(doc) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// Decode splits a blob into document bytes and signature WITHOUT verifying anything. Whitespace
// anywhere in the blob (line wrapping by a mail client) is ignored.
func Decode(blob string) (doc, sig []byte, err error) {
	if len(blob) > MaxBlobBytes {
		return nil, nil, errors.New("license: the text is too long to be a license")
	}
	blob = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) {
			return -1
		}
		return r
	}, blob)
	parts := strings.Split(blob, ".")
	if len(parts) != 3 || parts[0] != Prefix {
		return nil, nil, errors.New("license: not a license (expected RNL1.<document>.<signature>)")
	}
	enc := base64.RawURLEncoding.Strict()
	if doc, err = enc.DecodeString(parts[1]); err != nil {
		return nil, nil, errors.New("license: the document part is not valid base64url")
	}
	if sig, err = enc.DecodeString(parts[2]); err != nil {
		return nil, nil, errors.New("license: the signature part is not valid base64url")
	}
	if len(doc) == 0 || len(doc) > MaxDocumentBytes {
		return nil, nil, errors.New("license: document size is out of range")
	}
	if len(sig) != ed25519.SignatureSize {
		return nil, nil, errors.New("license: bad signature length")
	}
	return doc, sig, nil
}

// Verified is a license whose signature checked out.
type Verified struct {
	Doc   *Document
	KeyID string // key that signed it
	// Raw is the canonical blob (whitespace removed), what is stored and shown back.
	Raw string
}

// Verify checks the blob under one of keys and returns the parsed, validated document.
// With no keys it returns ErrNotConfigured.
func Verify(keys []ed25519.PublicKey, blob string) (*Verified, error) {
	if len(keys) == 0 {
		return nil, ErrNotConfigured
	}
	doc, sig, err := Decode(blob)
	if err != nil {
		return nil, err
	}
	var signer ed25519.PublicKey
	msg := SignedBytes(doc)
	for _, k := range keys {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, msg, sig) {
			signer = k
			break
		}
	}
	if signer == nil {
		return nil, errors.New("license: the signature does not verify under a trusted vendor license key")
	}
	d, err := parse(doc)
	if err != nil {
		return nil, err
	}
	return &Verified{Doc: d, KeyID: KeyID(signer), Raw: Encode(doc, sig)}, nil
}

// ParseUnverified decodes and validates a blob WITHOUT checking the signature. Only for display
// tools (`renovatio-license show`) and code that already verified the blob.
func ParseUnverified(blob string) (*Document, error) {
	doc, _, err := Decode(blob)
	if err != nil {
		return nil, err
	}
	return parse(doc)
}

func parse(doc []byte) (*Document, error) {
	var d Document
	dec := json.NewDecoder(bytes.NewReader(doc))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return nil, fmt.Errorf("license: bad document: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("license: trailing data after the document")
	}
	if err := d.Validate(); err != nil {
		return nil, err
	}
	return &d, nil
}

// Validate checks every field. It is used before signing and after parsing.
func (d *Document) Validate() error {
	switch {
	case d.Format != 1:
		return fmt.Errorf("license: unsupported document format %d", d.Format)
	case !idRe.MatchString(d.LicenseID):
		return errors.New("license: bad license_id")
	case strings.TrimSpace(d.Licensee) == "" || utf8.RuneCountInString(d.Licensee) > MaxLicensee || !printable(d.Licensee):
		return errors.New("license: bad licensee")
	case d.IssuedAt <= 0 || d.NotBefore <= 0:
		return errors.New("license: issued_at and not_before are required")
	case d.MaxDevices < 1 || d.MaxDevices > MaxDevices:
		return errors.New("license: max_devices is out of range")
	case d.Features == nil:
		return errors.New("license: features is required (use an empty list for none)")
	case len(d.Features) > MaxFeatures:
		return errors.New("license: too many features")
	case utf8.RuneCountInString(d.Notes) > MaxNotes || !printable(d.Notes):
		return errors.New("license: bad notes")
	}
	if d.ExpiresAt != nil {
		if *d.ExpiresAt <= 0 {
			return errors.New("license: bad expires_at")
		}
		if *d.ExpiresAt <= d.NotBefore {
			return errors.New("license: expires_at must be after not_before")
		}
	}
	if d.UpdatesUntil != nil && *d.UpdatesUntil <= 0 {
		return errors.New("license: bad updates_until")
	}
	seen := map[string]bool{}
	for _, f := range d.Features {
		if !featureRe.MatchString(f) {
			return fmt.Errorf("license: bad feature name %q", abbreviate(f))
		}
		if seen[f] {
			return fmt.Errorf("license: duplicate feature %q", f)
		}
		seen[f] = true
	}
	return nil
}

// printable accepts text without control characters other than newline and tab (notes only).
func printable(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return false
		}
	}
	return true
}

// Validity is a document's standing at one instant, ignoring any grace the caller applies.
type Validity int

const (
	// Valid: inside [not_before, expires_at] (or no expiry), with ClockSkew tolerance on both ends.
	Valid Validity = iota
	// NotYetValid: not_before is in the future by more than the skew.
	NotYetValid
	// Expired: expires_at is in the past by more than the skew.
	Expired
)

func (v Validity) String() string {
	switch v {
	case Valid:
		return "valid"
	case NotYetValid:
		return "not_yet_valid"
	default:
		return "expired"
	}
}

// At judges the document at now (the caller injects the clock). Tolerance: a clock that runs up to
// ClockSkew ahead does not make a fresh license "not yet valid", and one up to ClockSkew behind does
// not extend an expired subscription beyond that day.
func (d *Document) At(now time.Time) Validity {
	if now.Add(ClockSkew).Before(time.Unix(d.NotBefore, 0)) {
		return NotYetValid
	}
	if d.ExpiresAt != nil && now.Add(-ClockSkew).After(time.Unix(*d.ExpiresAt, 0)) {
		return Expired
	}
	return Valid
}

// ExpiryTime returns the subscription end, if any.
func (d *Document) ExpiryTime() (time.Time, bool) {
	if d.ExpiresAt == nil {
		return time.Time{}, false
	}
	return time.Unix(*d.ExpiresAt, 0).UTC(), true
}

// UpdatesEligible reports whether a release published at releasedAt (unix seconds, 0 = unknown) may
// be rolled out under this license. A license without updates_until covers every release. When the
// license has a cut-off, a release with no publication date cannot be shown to be eligible.
func (d *Document) UpdatesEligible(releasedAt int64) bool {
	if d.UpdatesUntil == nil {
		return true
	}
	return releasedAt > 0 && releasedAt <= *d.UpdatesUntil
}

// UpdatesUntilTime returns the update cut-off, if any.
func (d *Document) UpdatesUntilTime() (time.Time, bool) {
	if d.UpdatesUntil == nil {
		return time.Time{}, false
	}
	return time.Unix(*d.UpdatesUntil, 0).UTC(), true
}

// HasFeature reports whether the license names a feature.
func (d *Document) HasFeature(name string) bool {
	for _, f := range d.Features {
		if f == name {
			return true
		}
	}
	return false
}

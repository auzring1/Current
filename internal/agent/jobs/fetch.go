package jobs

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	agentv1 "github.com/auzring1/auzring/gen/proto/auzring/agent/v1"
)

// Fetcher opens the bytes of one content source. Every source is untrusted:
// the engine hashes what it receives and compares with the signed SHA-256.
type Fetcher interface {
	Open(ctx context.Context, src *agentv1.ContentSource, jobID string, sha []byte) (io.ReadCloser, error)
}

// ErrHashMismatch means the downloaded bytes do not match the signed hash.
var ErrHashMismatch = errors.New("jobs: downloaded content does not match the signed SHA-256")

// MultiFetcher dispatches by source kind.
type MultiFetcher struct {
	// Server fetches from the gateway (nil while disconnected).
	Server func(ctx context.Context, jobID string, sha []byte) (io.ReadCloser, error)
	HTTP   *http.Client
}

// Open implements Fetcher.
func (m *MultiFetcher) Open(ctx context.Context, src *agentv1.ContentSource, jobID string, sha []byte) (io.ReadCloser, error) {
	switch src.Kind {
	case agentv1.ContentSourceKind_CONTENT_SOURCE_KIND_SERVER:
		if m.Server == nil {
			return nil, errors.New("server content is not available while disconnected")
		}
		return m.Server(ctx, jobID, sha)
	case agentv1.ContentSourceKind_CONTENT_SOURCE_KIND_VENDOR:
		return m.vendor(ctx, src.Url)
	}
	return nil, errors.New("unknown content source")
}

func (m *MultiFetcher) vendor(ctx context.Context, raw string) (io.ReadCloser, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" {
		return nil, errors.New("vendor source must be an https URL")
	}
	client := m.HTTP
	if client == nil {
		client = &http.Client{Timeout: 0, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "https" {
				return errors.New("redirect to a non-https URL refused")
			}
			return nil
		}}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Auzring-Agent")
	resp, err := client.Do(req) // #nosec G107 G704 -- https-only URL from a signed job body, redirects constrained
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, fmt.Errorf("vendor server answered HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}

// download streams the first source whose bytes match sha and size into dst.
// It returns the number of sources that delivered mismatching bytes.
func (e *Engine) download(ctx context.Context, jobID string, in *agentv1.Installer, dst string) (mismatches int, err error) {
	var last error
	for _, src := range in.Sources {
		if ctx.Err() != nil {
			return mismatches, ctx.Err()
		}
		err := e.fetchOne(ctx, jobID, in, src, dst)
		if err == nil {
			return mismatches, nil
		}
		if errors.Is(err, ErrHashMismatch) {
			mismatches++
		}
		e.log().Warn("content source failed", "job", jobID, "kind", src.Kind.String(), "err", err)
		last = err
	}
	if last == nil {
		last = errors.New("no content source")
	}
	return mismatches, last
}

func (e *Engine) fetchOne(ctx context.Context, jobID string, in *agentv1.Installer, src *agentv1.ContentSource, dst string) error {
	rc, err := e.Fetch.Open(ctx, src, jobID, in.Sha256)
	if err != nil {
		return err
	}
	defer rc.Close()
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600) // #nosec G304 -- inside the protected staging dir
	if err != nil {
		return err
	}
	h := sha256.New()
	// One byte past the limit is enough to notice an over-long body. Vendor
	// manifests do not list sizes; the SHA-256 is the integrity guarantee and the
	// cap only bounds disk use.
	limit := in.Size
	if limit == 0 {
		limit = MaxInstallerBytes
	}
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(rc, int64(limit)+1)) // #nosec G110 G115 -- bounded
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if (in.Size != 0 && uint64(n) != in.Size) || uint64(n) > limit || subtle.ConstantTimeCompare(h.Sum(nil), in.Sha256) != 1 { // #nosec G115 -- n is non-negative
		_ = os.Remove(dst)
		return ErrHashMismatch
	}
	return nil
}

// hashFile re-hashes the locked handle (the TOCTOU-safe second check).
func hashLocked(r io.Reader) ([]byte, error) {
	h := sha256.New()
	if _, err := io.Copy(h, r); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

// Package webui serves the embedded single-page console with a strict,
// per-request-nonce Content-Security-Policy.
package webui

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/base64"
	"github.com/auzring1/renovatio/internal/shared/brand"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var dist embed.FS

const noncePlaceholder = "__CSP_NONCE__"

// Handler serves static assets and falls back to index.html for SPA routes.
func Handler() http.Handler {
	sub, _ := fs.Sub(dist, "dist")
	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		index = []byte(`<!doctype html><html><head><meta charset="utf-8"><title>` + brand.Name + `</title></head>` +
			`<body><p>The web console was not built into this binary. Run <code>make web</code> and rebuild.</p></body></html>`)
	}
	files := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := path.Clean("/" + r.URL.Path)
		if strings.HasPrefix(p, "/api/") {
			http.NotFound(w, r)
			return
		}
		if p != "/" && p != "/index.html" {
			if f, err := sub.Open(strings.TrimPrefix(p, "/")); err == nil {
				st, _ := f.Stat()
				_ = f.Close()
				if st != nil && !st.IsDir() {
					if strings.HasPrefix(p, "/assets/") {
						w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					}
					w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
					files.ServeHTTP(w, r)
					return
				}
			}
		}
		serveIndex(w, index)
	})
}

func serveIndex(w http.ResponseWriter, index []byte) {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	nonce := base64.StdEncoding.EncodeToString(b)
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Security-Policy", strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'nonce-" + nonce + "'",
		"img-src 'self' data:",
		"font-src 'self'",
		"connect-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; "))
	_, _ = w.Write(bytes.ReplaceAll(index, []byte(noncePlaceholder), []byte(nonce)))
}

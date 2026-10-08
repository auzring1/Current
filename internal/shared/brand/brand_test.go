package brand

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"unicode/utf16"
)

func repoRoot(t *testing.T) string {
	t.Helper()
	_, f, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(f), "..", "..", ".."))
}

var skipDirs = map[string]bool{".git": true, "node_modules": true, ".claude": true, "gen": true, "dist": true,
	"loadtest-results": true, "dist-demo": true, "dist-release": true, "test-results": true, "playwright-report": true}

// walk calls fn for every text file of the repository that can reach a user.
func walk(t *testing.T, fn func(rel string, data []byte)) {
	t.Helper()
	root := repoRoot(t)
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			// Generated protobuf code sits under gen/ at the repository root only; the web console has its own gen-free tree.
			if skipDirs[d.Name()] && !(d.Name() == "dist" && !strings.HasPrefix(rel, "internal/")) {
				return filepath.SkipDir
			}
			if rel == "db/migrations" { // applied migrations are immutable
				return filepath.SkipDir
			}
			return nil
		}
		switch rel {
		case "go.sum", "web/package-lock.json", "RENAME-PLAN.md":
			return nil
		}
		switch filepath.Ext(rel) {
		case ".syso", ".png", ".ico", ".woff", ".woff2", ".gz", ".zip", ".exe", ".age":
			return nil
		}
		data, err := os.ReadFile(p)
		if err != nil || !utf8Text(data) {
			return nil
		}
		fn(rel, data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func utf8Text(b []byte) bool {
	for _, c := range b[:min(len(b), 4096)] {
		if c == 0 {
			return false
		}
	}
	return true
}

// companyFiles may name the company (Auzring) because the company is not the product.
var companyFiles = map[string]bool{
	"LICENSE": true, "internal/shared/brand/brand.go": true, "internal/shared/brand/brand_test.go": true,
	"web/src/brand.generated.ts": true, "cmd/renovatio-agent/winres/winres.json": true,
}

// githubOrg is the GitHub organisation, which is named after the company.
var githubOrg = regexp.MustCompile(`auzring1`)

// TestPreviousNameIsGone fails when "Auzring" (in any spelling) appears anywhere in the repository except as the
// company name or as the GitHub organisation (auzring1) in a repository path.
func TestPreviousNameIsGone(t *testing.T) {
	var bad []string
	walk(t, func(rel string, data []byte) {
		if companyFiles[rel] {
			return
		}
		for i, line := range strings.Split(string(data), "\n") {
			if strings.HasSuffix(rel, ".md") && strings.Contains(strings.ToLower(line), "company") {
				continue // prose that names the company (Auzring) next to the word "company"
			}
			if strings.HasSuffix(rel, ".md") && strings.Contains(line, "<!-- old-name -->") {
				continue // clean-up instructions that must name the old files
			}
			l := githubOrg.ReplaceAllString(line, "")
			if strings.Contains(strings.ToLower(l), "auzring") {
				bad = append(bad, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
	})
	if len(bad) > 0 {
		t.Fatalf("the previous product name is still spelled in %d places (use the brand package, the generated web constants or the WiX defines):\n%s",
			len(bad), strings.Join(bad, "\n"))
	}
}

// TestNameIsNotHardCoded fails when the current product name is typed into a Go string literal, a web
// source file or an MSI attribute: it must come from the single source of truth.
func TestNameIsNotHardCoded(t *testing.T) {
	var bad []string
	root := repoRoot(t)
	walk(t, func(rel string, data []byte) {
		switch {
		case strings.HasSuffix(rel, ".go") && !strings.HasSuffix(rel, "_test.go") && !strings.HasPrefix(rel, "internal/shared/brand/"):
			fset := token.NewFileSet()
			f, err := parser.ParseFile(fset, filepath.Join(root, rel), data, 0)
			if err != nil {
				return
			}
			ast.Inspect(f, func(n ast.Node) bool {
				if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
					if v, err := strconv.Unquote(lit.Value); err == nil && strings.Contains(v, Name) {
						bad = append(bad, rel+":"+strconv.Itoa(fset.Position(lit.Pos()).Line)+": "+lit.Value)
					}
				}
				return true
			})
		case strings.HasPrefix(rel, "web/src/") && rel != "web/src/brand.generated.ts" && !strings.HasSuffix(rel, "schema.d.ts") &&
			(strings.HasSuffix(rel, ".ts") || strings.HasSuffix(rel, ".tsx")) && !strings.HasSuffix(rel, ".test.ts"):
			for i, line := range strings.Split(string(data), "\n") {
				if strings.Contains(line, Name) {
					bad = append(bad, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
				}
			}
		case strings.HasSuffix(rel, ".wxs") || strings.HasSuffix(rel, ".wxi"):
			noComments := regexp.MustCompile(`(?s)<!--.*?-->`).ReplaceAllString(string(data), "")
			if strings.Contains(noComments, Name) {
				bad = append(bad, rel+": the product name is spelled in an attribute; use $(ProductName), $(AgentName) or $(Company)")
			}
		case rel == "web/index.html":
			if strings.Contains(string(data), Name) {
				bad = append(bad, rel+": use %PRODUCT_NAME%")
			}
		}
	})
	if len(bad) > 0 {
		t.Fatalf("the product name must come from internal/shared/brand, not be typed:\n%s", strings.Join(bad, "\n"))
	}
}

// TestGeneratedWebConstantsMatch keeps the web console's generated module in step with the Go constants.
func TestGeneratedWebConstantsMatch(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "web", "src", "brand.generated.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`PRODUCT_NAME = "` + Name + `"`, `AGENT_NAME = "` + AgentName + `"`, `COMPANY_NAME = "` + Company + `"`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("web/src/brand.generated.ts lacks %s (run: go generate ./internal/shared/brand)", want)
		}
	}
}

// TestAgentVersionResource checks that the compiled Windows version resource says what Task Manager and the
// file properties should show.
func TestAgentVersionResource(t *testing.T) {
	b, err := os.ReadFile(filepath.Join(repoRoot(t), "cmd", "renovatio-agent", "rsrc_windows_amd64.syso"))
	if err != nil {
		t.Fatal(err)
	}
	utf16le := func(s string) []byte {
		var out []byte
		for _, u := range utf16.Encode([]rune(s)) {
			out = append(out, byte(u), byte(u>>8))
		}
		return out
	}
	for _, s := range []string{AgentName, Name, Company} {
		if !strings.Contains(string(b), string(utf16le(s))) {
			t.Errorf("the agent's version resource does not contain %q (regenerate: make winres)", s)
		}
	}
}

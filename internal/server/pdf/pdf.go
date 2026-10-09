// Package pdf writes simple table reports as PDF 1.4 using only the standard library and the three built-in fonts
// (Helvetica, Helvetica-Bold, Courier), so there is nothing to embed and no dependency to trust. Tables use a
// monospaced font so columns line up without measuring text. Text outside Latin-1 is shown as "?".
package pdf

import (
	"bytes"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Page geometry: A4 landscape, in points.
const (
	pageW, pageH = 842.0, 595.0
	margin       = 36.0
	bodySize     = 8.0
	lineH        = 11.0
	headerH      = 78.0
	footerH      = 28.0
)

// Column is one table column; Width is in characters.
type Column struct {
	Header string
	Width  int
}

// Doc describes a report. Accent is the brand color of the header bar (r, g, b in 0..1).
type Doc struct {
	OrgName     string
	ProductName string
	Title       string
	Note        string
	Footer      string
	Accent      [3]float64
	Generated   time.Time
}

func latin1(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\t':
			b.WriteByte(' ')
		case r < 32 || r == 127:
			b.WriteByte('?')
		case r > 255:
			b.WriteByte('?')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// esc escapes a string for a PDF literal and encodes it as Latin-1 bytes.
func esc(s string) string {
	s = latin1(s)
	var b bytes.Buffer
	b.WriteByte('(')
	for _, r := range s {
		switch r {
		case '(', ')', '\\':
			b.WriteByte('\\')
			b.WriteByte(byte(r))
		default:
			b.WriteByte(byte(r)) // #nosec G115 -- latin1() has already replaced every rune above 255
		}
	}
	b.WriteByte(')')
	return b.String()
}

func fit(s string, w int) string {
	s = strings.NewReplacer("\r", " ", "\n", " ").Replace(latin1(s))
	if utf8.RuneCountInString(s) <= w {
		return s + strings.Repeat(" ", w-utf8.RuneCountInString(s))
	}
	if w <= 3 {
		return string([]rune(s)[:w])
	}
	return string([]rune(s)[:w-3]) + "..."
}

// Table renders the document with the table, paginated. The header row repeats on every page.
func (d Doc) Table(cols []Column, rows [][]string) []byte {
	usable := int(160) // (842 - 2*36) / (8 * 0.6) characters of Courier 8pt
	total := 0
	for _, c := range cols {
		total += c.Width + 2
	}
	if total > usable { // shrink the widest columns until it fits
		for total > usable {
			wi := 0
			for i, c := range cols {
				if c.Width > cols[wi].Width {
					wi = i
				}
			}
			if cols[wi].Width <= 6 {
				break
			}
			cols = append([]Column(nil), cols...)
			cols[wi].Width--
			total--
		}
	}
	line := func(cells []string) string {
		var b strings.Builder
		for i, c := range cols {
			v := ""
			if i < len(cells) {
				v = cells[i]
			}
			b.WriteString(fit(v, c.Width))
			b.WriteString("  ")
		}
		return strings.TrimRight(b.String(), " ")
	}
	heads := make([]string, len(cols))
	for i, c := range cols {
		heads[i] = c.Header
	}
	perPage := 37 // (595 - 2*36 - 78 - 28) / 11 lines
	if perPage < 5 {
		perPage = 5
	}
	pages := (len(rows) + perPage - 1) / perPage
	if pages == 0 {
		pages = 1
	}
	gen := d.Generated
	if gen.IsZero() {
		gen = time.Now()
	}

	var objs [][]byte // 1-based object numbers are index+1
	add := func(b string) int { objs = append(objs, []byte(b)); return len(objs) }
	add("<< /Type /Catalog /Pages 2 0 R >>")
	add("") // pages, filled in at the end
	add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
	add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
	add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>")
	var kids []string
	for p := 0; p < pages; p++ {
		var c bytes.Buffer
		// Header bar in the brand color, then the names and the title.
		fmt.Fprintf(&c, "%.3f %.3f %.3f rg %.1f %.1f %.1f %.1f re f\n", d.Accent[0], d.Accent[1], d.Accent[2], margin, pageH-margin-6, pageW-2*margin, 6.0)
		fmt.Fprintf(&c, "0.1 0.1 0.1 rg BT /F2 16 Tf %.1f %.1f Td %s Tj ET\n", margin, pageH-margin-30, esc(orDefault(d.OrgName, d.ProductName)))
		if d.OrgName != "" && d.ProductName != "" {
			fmt.Fprintf(&c, "0.35 0.35 0.35 rg BT /F1 9 Tf %.1f %.1f Td %s Tj ET\n", margin, pageH-margin-43, esc(d.ProductName))
		}
		fmt.Fprintf(&c, "0.1 0.1 0.1 rg BT /F2 12 Tf %.1f %.1f Td %s Tj ET\n", margin, pageH-margin-60, esc(d.Title))
		sub := "Generated " + gen.UTC().Format("2006-01-02 15:04 UTC")
		if d.Note != "" {
			sub = d.Note + "   |   " + sub
		}
		fmt.Fprintf(&c, "0.35 0.35 0.35 rg BT /F1 8 Tf %.1f %.1f Td %s Tj ET\n", margin, pageH-margin-72, esc(sub))
		y := pageH - margin - headerH
		fmt.Fprintf(&c, "0.1 0.1 0.1 rg BT /F3 %.1f Tf %.1f %.1f Td %s Tj ET\n", bodySize, margin, y, esc(line(heads)))
		fmt.Fprintf(&c, "0.6 0.6 0.6 RG 0.5 w %.1f %.1f m %.1f %.1f l S\n", margin, y-3, pageW-margin, y-3)
		y -= lineH + 2
		lo, hi := p*perPage, min((p+1)*perPage, len(rows))
		for _, r := range rows[lo:hi] {
			fmt.Fprintf(&c, "0 0 0 rg BT /F3 %.1f Tf %.1f %.1f Td %s Tj ET\n", bodySize, margin, y, esc(line(r)))
			y -= lineH
		}
		foot := d.Footer
		fmt.Fprintf(&c, "0.35 0.35 0.35 rg BT /F1 8 Tf %.1f %.1f Td %s Tj ET\n", margin, margin-4, esc(fmt.Sprintf("%s   Page %d of %d", foot, p+1, pages)))
		content := c.String()
		cn := add(fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content))
		pn := add(fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %.0f %.0f] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents %d 0 R >>", pageW, pageH, cn))
		kids = append(kids, fmt.Sprintf("%d 0 R", pn))
	}
	objs[1] = []byte(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pages))

	var out bytes.Buffer
	out.WriteString("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
	offs := make([]int, len(objs))
	for i, o := range objs {
		offs[i] = out.Len()
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", i+1, o)
	}
	x := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, o := range offs {
		fmt.Fprintf(&out, "%010d 00000 n \n", o)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R /Info << /Title %s /Producer (%s) >> >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, esc(d.Title), esc(orDefault(d.ProductName, "report")), x)
	return out.Bytes()
}

func orDefault(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// ParseHexColor turns "#1971c2" into r, g, b in 0..1 (a mid blue if it does not parse).
func ParseHexColor(s string) [3]float64 {
	var r, g, b int
	if _, err := fmt.Sscanf(strings.TrimPrefix(s, "#"), "%02x%02x%02x", &r, &g, &b); err != nil {
		return [3]float64{0.1, 0.44, 0.76}
	}
	return [3]float64{float64(r) / 255, float64(g) / 255, float64(b) / 255}
}

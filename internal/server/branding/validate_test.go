package branding

import (
	"strings"
	"testing"
)

func fieldsOf(t *testing.T, err error) map[string]string {
	t.Helper()
	ve, ok := err.(*ValidationError)
	if !ok {
		t.Fatalf("want a ValidationError, got %v", err)
	}
	return ve.Fields
}

func TestValidateNormalizes(t *testing.T) {
	got, err := Validate(Settings{
		OrgName: "  Example Clinic \n", AccentColor: " #1971C2 ", LoginMessage: "Line one\r\nLine two",
		SupportEmail: "Help@Example.org", SupportPhone: "+1 (555) 010-0100 x12", SupportURL: "https://example.org/help",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.OrgName != "Example Clinic" || got.AccentColor != "#1971c2" || got.LoginMessage != "Line one\nLine two" || got.SupportEmail != "help@example.org" {
		t.Fatalf("not normalized: %+v", got)
	}
}

func TestValidateRejects(t *testing.T) {
	long := func(n int) string { return strings.Repeat("a", n) }
	cases := []struct {
		name  string
		in    Settings
		field string
	}{
		{"org too long", Settings{OrgName: long(121)}, "org_name"},
		{"org control char", Settings{OrgName: "Bad\x07Name"}, "org_name"},
		{"org newline", Settings{OrgName: "Two\nLines"}, "org_name"},
		{"org bidi override", Settings{OrgName: "evil\u202eexe.txt"}, "org_name"},
		{"product too long", Settings{ProductName: long(61)}, "product_name"},
		{"headline too long", Settings{LoginHeadline: long(121)}, "login_headline"},
		{"message too long", Settings{LoginMessage: long(1001)}, "login_message"},
		{"footer too long", Settings{LoginFooter: long(1001)}, "login_footer"},
		{"report footer too long", Settings{ReportFooter: long(501)}, "report_footer"},
		{"invalid utf8", Settings{OrgName: "bad\xff"}, "org_name"},
		{"color name", Settings{AccentColor: "blue"}, "accent_color"},
		{"short hex", Settings{AccentColor: "#17c"}, "accent_color"},
		{"css injection", Settings{AccentColor: "#1971c2;background:url(x)"}, "accent_color"},
		{"secondary garbage", Settings{SecondaryColor: "rgb(1,2,3)"}, "secondary_color"},
		{"email with name", Settings{SupportEmail: "Help <help@example.org>"}, "support_email"},
		{"email garbage", Settings{SupportEmail: "not an email"}, "support_email"},
		{"phone letters", Settings{SupportPhone: "call me maybe"}, "support_phone"},
		{"http link", Settings{SupportURL: "http://example.org"}, "support_url"},
		{"javascript link", Settings{SupportURL: "javascript:alert(1)"}, "support_url"},
		{"data link", Settings{SupportURL: "data:text/html,<script>alert(1)</script>"}, "support_url"},
		{"link with credentials", Settings{SupportURL: "https://user:pw@example.org/"}, "support_url"},
		{"link with quote", Settings{SupportURL: `https://example.org/"onmouseover=alert(1)`}, "support_url"},
		{"link without host", Settings{SupportURL: "https:///path"}, "support_url"},
		{"low contrast accent", Settings{AccentColor: "#ffd43b"}, "accent_color"},
	}
	for _, c := range cases {
		_, err := Validate(c.in)
		if err == nil {
			t.Errorf("%s: accepted", c.name)
			continue
		}
		if fieldsOf(t, err)[c.field] == "" {
			t.Errorf("%s: no message on %s: %v", c.name, c.field, err)
		}
	}
}

func TestValidateAllowsEmptyAsDefault(t *testing.T) {
	got, err := Validate(Settings{})
	if err != nil || got != (Settings{}) {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestResolveDefaults(t *testing.T) {
	p := resolve(Settings{}, nil)
	if p.ProductName != "Renovatio" || p.OrgName != "" || p.AccentColor != DefaultAccent || p.Title != "Renovatio" {
		t.Fatalf("a fresh install shows the product with no organization: %+v", p)
	}
	p = resolve(Settings{OrgName: "Example Clinic", ProductName: "PatchBoard"}, nil)
	if p.Title != "Example Clinic · PatchBoard" || p.ProductName != "PatchBoard" {
		t.Fatalf("%+v", p)
	}
	a := resolve(Settings{OrgName: "A"}, nil)
	b := resolve(Settings{OrgName: "B"}, nil)
	if a.Version == b.Version || a.Version == "" {
		t.Fatal("the version must change with the content")
	}
}

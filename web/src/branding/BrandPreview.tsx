import { useState } from "react";
import { Box, SegmentedControl, Stack, Text } from "@mantine/core";
import type { BrandingSettings, BrandingView } from "../api/client";
import { PRODUCT_NAME } from "../brand.generated";
import { DARK_SURFACE, DEFAULT_ACCENT, isHexColor, WHITE } from "./contrast";
import { palette } from "./theme";

interface Props {
  draft: BrandingSettings;
  view: BrandingView;
}

type Scheme = "light" | "dark";

const ink = { light: "#1a1b1e", dark: "#c9c9c9" } as const;
const muted = { light: "#495057", dark: "#a6a7ab" } as const;
const surface = { light: WHITE, dark: DARK_SURFACE } as const;
const card = { light: "#ffffff", dark: "#25262b" } as const;
const line = { light: "#ced4da", dark: "#373a40" } as const;

/**
 * A faithful sketch of the top bar and sign-in page with the values being edited. It uses plain elements and inline
 * styles (not the live theme) so it can show a color before it is saved, on both the light and the dark theme.
 */
export function BrandPreview({ draft, view }: Props) {
  const [scheme, setScheme] = useState<Scheme>("light");
  const accent = isHexColor(draft.accent_color ?? "") ? draft.accent_color!.toLowerCase() : DEFAULT_ACCENT;
  const secondary = isHexColor(draft.secondary_color ?? "") ? draft.secondary_color!.toLowerCase() : "";
  const product = (draft.product_name ?? "").trim() || view.defaults.product_name || PRODUCT_NAME;
  const org = (draft.org_name ?? "").trim();
  const linkColor = scheme === "dark" ? palette(accent)[4] : accent;

  const logoRef = scheme === "dark" ? (view.assets.logo_dark ?? view.assets.logo_light) : (view.assets.logo_light ?? view.assets.logo_dark);
  const needsChip = scheme === "dark" ? !view.assets.logo_dark && !!view.assets.logo_light : !view.assets.logo_light && !!view.assets.logo_dark;
  const mark = (h: number) => {
    const ref = logoRef ?? view.assets.icon;
    if (!ref) return null;
    const img = <img src={ref.url} alt="" style={{ height: h, width: "auto", maxWidth: 200, display: "block" }} />;
    return needsChip && logoRef ? <div style={{ background: scheme === "dark" ? WHITE : DARK_SURFACE, padding: 4, borderRadius: 6, lineHeight: 0 }}>{img}</div> : img;
  };
  const support = [draft.support_email, draft.support_phone, draft.support_url ? "Support site" : ""].filter(Boolean).join(" · ");

  return (
    <Stack gap="xs" data-testid="brand-preview">
      <SegmentedControl
        size="xs"
        value={scheme}
        onChange={(v) => setScheme(v as Scheme)}
        data={[
          { value: "light", label: "Light theme" },
          { value: "dark", label: "Dark theme" },
        ]}
        aria-label="Preview theme"
      />
      <Box style={{ border: `1px solid ${line[scheme]}`, borderRadius: 8, overflow: "hidden", background: surface[scheme], color: ink[scheme] }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: `3px solid ${secondary || accent}` }}>
          {mark(28)}
          <strong data-testid="preview-product">{product}</strong>
          {org && (
            <span data-testid="preview-org" style={{ color: muted[scheme], fontSize: 13 }}>
              {org}
            </span>
          )}
          <span style={{ marginLeft: "auto", fontSize: 12, color: linkColor }}>Sign out</span>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <div style={{ width: "100%", maxWidth: 320, background: card[scheme], border: `1px solid ${line[scheme]}`, borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            {mark(36)}
            <div style={{ fontSize: 18, fontWeight: 700 }} data-testid="preview-headline">
              {(draft.login_headline ?? "").trim() || `Sign in to ${product}`}
            </div>
            {org && <div style={{ fontSize: 12, color: muted[scheme] }}>{org}</div>}
            {draft.login_message && <div style={{ fontSize: 13, whiteSpace: "pre-line" }}>{draft.login_message}</div>}
            <div style={{ border: `1px solid ${line[scheme]}`, borderRadius: 4, height: 28 }} />
            <div style={{ border: `1px solid ${line[scheme]}`, borderRadius: 4, height: 28 }} />
            <div style={{ background: accent, color: WHITE, borderRadius: 4, textAlign: "center", padding: "6px 0", fontWeight: 600, fontSize: 14 }}>Continue</div>
            <div style={{ fontSize: 12, color: linkColor }}>Use a recovery code instead</div>
          </div>
          {draft.login_footer && (
            <div style={{ fontSize: 11, color: muted[scheme], textAlign: "center", whiteSpace: "pre-line", maxWidth: 320 }} data-testid="preview-footer">
              {draft.login_footer}
            </div>
          )}
          {support && (
            <div style={{ fontSize: 11, textAlign: "center", color: linkColor }} data-testid="preview-support">
              Need help? {support}
            </div>
          )}
        </div>
      </Box>
      <Text size="xs" c="dimmed">
        Preview only. Images show what is stored; texts and colors update as you type.
      </Text>
    </Stack>
  );
}

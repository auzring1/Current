import { createTheme, type MantineColorsTuple, type MantineTheme } from "@mantine/core";
import { contrast, DARK_SURFACE, DEFAULT_ACCENT, isHexColor, MIN_TEXT, parseHex, toHex } from "./contrast";

type Rgb = [number, number, number];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/**
 * Builds Mantine's ten shades from one color. Shade 6 is exactly the chosen color (the server has checked that
 * white text on it and the color on the dark theme are readable). Shade 4 is the color Mantine uses for links and
 * text in the dark theme, so it is lightened until it reaches 4.5:1 on the dark surface.
 */
export function palette(color: string): MantineColorsTuple {
  const base = parseHex(isHexColor(color) ? color : DEFAULT_ACCENT);
  let t4 = 0.3;
  while (t4 < 0.95 && contrast(toHex(mix(base, WHITE, t4)), DARK_SURFACE) < MIN_TEXT) t4 += 0.05;
  const at = (f: number) => t4 + (1 - t4) * f; // tints get lighter towards shade 0
  const tints = [at(0.93), at(0.82), at(0.62), at(0.33), t4, t4 / 2];
  const shades = tints.map((t) => toHex(mix(base, WHITE, t)));
  const darks = [0.14, 0.28, 0.42].map((t) => toHex(mix(base, BLACK, t)));
  return [...shades, toHex(base), ...darks] as unknown as MantineColorsTuple;
}

export interface ThemeInput {
  accent: string;
  secondary: string;
}

/** The console theme for a deployment: the accent becomes Mantine's primary color. */
export function buildTheme({ accent, secondary }: ThemeInput) {
  const colors: Record<string, MantineColorsTuple> = { brand: palette(accent || DEFAULT_ACCENT) };
  if (secondary) colors.secondary = palette(secondary);
  return createTheme({
    primaryColor: "brand",
    primaryShade: { light: 6, dark: 6 },
    colors,
  });
}

/** Secondary color for decorative graphics (borders, the active menu marker); falls back to the accent. */
export const decorColor = (theme: MantineTheme, secondary: string): string =>
  (secondary ? theme.colors.secondary?.[6] : theme.colors.brand?.[6]) ?? DEFAULT_ACCENT;

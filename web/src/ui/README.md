# Console design system

Everything visual comes from **semantic tokens** (`var(--rnv-*)`), defined per theme in `src/design/themes/*.css` and
shared in `src/design/tokens.css`. Components never use raw colors (a test fails if they do).

* **Themes**: one CSS file each (`light`, `dark`, `slate`, `midnight`, `contrast`). Add a file, get a theme. Every pair of
  tokens is checked against WCAG AA by `src/design/themes.test.ts`. The branding accent is layered on top of every theme by
  `src/design/accent.ts` (it adapts the accent per theme so it stays readable).
* **Mantine** supplies behaviour and accessibility (modal, menu, tabs, inputs...). Its color variables are bridged to the
  tokens in `src/design/mantine-bridge.css`, so `color="red"`, `c="dimmed"` etc. follow the theme. Prefer the components
  below for status, layout and data.
* **Icons**: only from `src/ui/icons.ts` (Tabler, bundled). Decorative icons get `aria-hidden`.
* **Fonts**: Inter, bundled (no CDN). No runtime network requests.

## Page recipe

```tsx
import { Page, PageHeader, DataTable, StatGrid, StatTile, Status, StatusPill, SeverityBadge, EmptyState, Card, Icons, toast, useConfirm, type Column } from "../ui";

<Page>
  <PageHeader title="Devices" description="…" breadcrumbs={[{label:"Monitor"},{label:"Devices"}]} actions={<Button>…</Button>} />
  <StatGrid label="Fleet summary"><StatTile label="Online" value={211} kind="success" icon={<Icons.Online size={16} aria-hidden />} /></StatGrid>
  <DataTable id="devices" label="Devices" data={rows} columns={cols} rowId={(r) => r.id} … />
</Page>
```

* One `h1` per page (from `PageHeader`); sections inside cards use `Card title=…` (h2).
* **Status is icon + color + text**: `<Status value="active" />` maps API words to pills; `<StatusPill kind="warning">Text</StatusPill>`
  for anything else; `<SeverityBadge severity="critical" />` for update severity (Critical/Important/Moderate/Low).
* **Lists are `DataTable`s**: columns declare `value` (sort/search/filter/CSV), `cell` (rendering), `filter` (chips), `defaultHidden`,
  `required`, `primary` (+ `rowHref`), `width`. Give each table a stable `id` (saved views and layout are keyed by it).
  Bulk actions go in `bulkActions`, hover actions in `rowActions`, extra toolbar controls in `toolbar`.
* **Feedback**: `toast.success/error/warning/info(message)` instead of `notifications.show`; `const confirm = useConfirm();
  if (await confirm({ title, message, confirmLabel, danger: true })) …` for destructive actions.
* **Loading / empty**: `TableSkeleton`, `TileSkeleton`, `Skel`; `EmptyState` with an action.
* **Charts**: `StackedBar`, `Donut` with `token` = a status/severity family (`success`, `critical`…) or `chart-1..6`.
* `/styleguide` (administrators) shows every component in the active theme.

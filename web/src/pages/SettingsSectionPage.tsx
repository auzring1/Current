import { useParams } from "react-router-dom";
import { EmptyState, Icons } from "../ui";
import { SETTINGS_SECTIONS } from "../ui/nav";

/** A Settings section that has no page of its own yet. */
export function SettingsSectionPage() {
  const { section } = useParams();
  const s = SETTINGS_SECTIONS.find((x) => x.id === section);
  return <EmptyState icon={<Icons.NavSettings size={26} />} title={s ? `${s.label} settings` : "Unknown settings section"} description={s ? "This section is not available yet." : "Choose a section from the list."} />;
}

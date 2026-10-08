import { useQuery } from "@tanstack/react-query";
import { Alert, Anchor } from "@mantine/core";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { licenseBanner, type LicenseStatus } from "../api/license";
import { useSession } from "../api/session";
import { Icons } from "../ui";

/** Shown on the Devices page when the device cap is reached or the license is ending. */
export function LicenseBanner() {
  const { canOrg } = useSession();
  const q = useQuery({
    queryKey: ["license"],
    queryFn: () => api<LicenseStatus>("GET", "/license"),
    enabled: canOrg("license:read"),
    refetchInterval: 60_000,
  });
  const b = licenseBanner(q.data);
  if (!b) return null;
  // Status is never color alone: the icon and the title say it too.
  const icon = b.color === "red" ? <Icons.Danger size={18} aria-hidden /> : <Icons.Warning size={18} aria-hidden />;
  return (
    <Alert color={b.color} icon={icon} title={b.title} data-testid="license-banner">
      {b.text}{" "}
      {canOrg("license:write") && (
        <Anchor component={Link} to="/license">
          Open License
        </Anchor>
      )}
    </Alert>
  );
}

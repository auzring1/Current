import type { ComponentType } from "react";
import * as I from "./icons";

export interface NavItem {
  to: string;
  label: string;
  /** The permission needed to see the link. */
  perm: string;
  /** Visible with the permission for some sites only (the device pages). */
  any?: boolean;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** The console's navigation, in groups. Links the person may not use are filtered out by the shell. */
export const NAV: NavGroup[] = [
  {
    label: "Monitor",
    items: [
      { to: "/", label: "Devices", perm: "devices:read", any: true, icon: I.NavDevices },
      { to: "/software", label: "Software", perm: "devices:read", icon: I.NavSoftware },
      { to: "/groups", label: "Groups", perm: "groups:read", icon: I.NavGroups },
    ],
  },
  {
    label: "Patching",
    items: [
      { to: "/updates", label: "Windows updates", perm: "updates:read", icon: I.NavUpdates },
      { to: "/update-policy", label: "Update policy", perm: "updates:read", icon: I.NavPolicy },
      { to: "/policies", label: "Software policies", perm: "policies:read", icon: I.NavSoftwarePolicy },
      { to: "/catalog", label: "Catalog", perm: "catalog:read", icon: I.NavCatalog },
      { to: "/deployments", label: "Deployments", perm: "deployments:read", icon: I.NavDeployments },
    ],
  },
  {
    label: "Insights",
    items: [
      { to: "/reports", label: "Reports", perm: "reports:read", icon: I.NavReports },
      { to: "/audit", label: "Audit log", perm: "audit:read", icon: I.NavAudit },
    ],
  },
  {
    label: "Administration",
    items: [
      { to: "/enrollment", label: "Enrollment", perm: "enrollment:read", icon: I.NavEnrollment },
      { to: "/agent-updates", label: "Agent updates", perm: "releases:read", icon: I.NavAgentUpdates },
      { to: "/sites", label: "Sites", perm: "sites:write", icon: I.NavSites },
      { to: "/users", label: "Users", perm: "users:read", icon: I.NavUsers },
      { to: "/license", label: "License", perm: "license:write", icon: I.NavLicense },
      { to: "/settings", label: "Settings", perm: "catalog:read", icon: I.NavSettings },
      { to: "/styleguide", label: "Style guide", perm: "branding:write", icon: I.Palette },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

import { lazy, Suspense } from "react";
import { Center, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { useSession } from "./api/session";
import { Layout } from "./components/Layout";
import { SettingsLayout, SettingsPage } from "./pages/SettingsPage";
import { DevicesPage } from "./pages/DevicesPage";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";

// Pages other than the first screens load on demand, which keeps the first download small.
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const AuditPage = page(() => import("./pages/AuditPage"), "AuditPage");
const CatalogPage = page(() => import("./pages/CatalogPage"), "CatalogPage");
const DeploymentPage = page(() => import("./pages/DeploymentPage"), "DeploymentPage");
const DeploymentsPage = page(() => import("./pages/DeploymentsPage"), "DeploymentsPage");
const NewDeploymentPage = page(() => import("./pages/NewDeploymentPage"), "NewDeploymentPage");
const PackagePage = page(() => import("./pages/PackagePage"), "PackagePage");
const BrandingPage = page(() => import("./pages/BrandingPage"), "BrandingPage");
const StyleGuidePage = page(() => import("./pages/StyleGuidePage"), "StyleGuidePage");
const DevicePage = page(() => import("./pages/DevicePage"), "DevicePage");
const GroupsPage = page(() => import("./pages/GroupsPage"), "GroupsPage");
const SoftwarePage = page(() => import("./pages/SoftwarePage"), "SoftwarePage");
const TokensPage = page(() => import("./pages/TokensPage"), "TokensPage");
const PoliciesPage = page(() => import("./pages/PoliciesPage"), "PoliciesPage");
const ReportsPage = page(() => import("./pages/ReportsPage"), "ReportsPage");
const AgentUpdatesPage = page(() => import("./pages/AgentUpdatesPage"), "AgentUpdatesPage");
const LicensePage = page(() => import("./pages/LicensePage"), "LicensePage");
const AccountPage = page(() => import("./pages/AccountPage"), "AccountPage");
const SitesPage = page(() => import("./pages/SitesPage"), "SitesPage");
const UsersPage = page(() => import("./pages/UsersPage"), "UsersPage");
const UpdatePolicyPage = page(() => import("./pages/UpdatePolicyPage"), "UpdatePolicyPage");
const UpdatesPage = page(() => import("./pages/UpdatesPage"), "UpdatesPage");

export function App() {
  const loc = useLocation();
  const setup = useQuery({ queryKey: ["setup"], queryFn: () => api<{ setup_required: boolean }>("GET", "/setup/status") });
  const { session, loading } = useSession();

  if (setup.isLoading || loading) {
    return (
      <Center mih="100vh">
        <Loader />
      </Center>
    );
  }
  // Setup must finish (including showing recovery codes) before anything else.
  if (setup.data?.setup_required || loc.pathname === "/setup") {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={setup.data?.setup_required ? <Navigate to="/setup" replace /> : <Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <Suspense
      fallback={
        <Center mih="40vh">
          <Loader />
        </Center>
      }
    >
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route element={session ? <Layout /> : <Navigate to="/login" replace />}>
        <Route index element={<DevicesPage />} />
        <Route path="/devices/:id" element={<DevicePage />} />
        <Route path="/software" element={<SoftwarePage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="/catalog/:id" element={<PackagePage />} />
        <Route path="/policies" element={<PoliciesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/agent-updates" element={<AgentUpdatesPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/sites" element={<SitesPage />} />
        <Route path="/updates" element={<UpdatesPage />} />
        <Route path="/update-policy" element={<UpdatePolicyPage />} />
        <Route path="/deployments" element={<DeploymentsPage />} />
        <Route path="/deployments/new" element={<NewDeploymentPage />} />
        <Route path="/deployments/:id" element={<DeploymentPage />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<SettingsPage />} />
          <Route path="branding" element={<BrandingPage />} />
        </Route>
        <Route path="/license" element={<LicensePage />} />
        <Route path="/styleguide" element={<StyleGuidePage />} />
        <Route path="/enrollment" element={<TokensPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </Suspense>
  );
}

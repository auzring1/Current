import { Center, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { useSession } from "./api/session";
import { Layout } from "./components/Layout";
import { AuditPage } from "./pages/AuditPage";
import { CatalogPage } from "./pages/CatalogPage";
import { DeploymentPage } from "./pages/DeploymentPage";
import { DeploymentsPage } from "./pages/DeploymentsPage";
import { NewDeploymentPage } from "./pages/NewDeploymentPage";
import { PackagePage } from "./pages/PackagePage";
import { SettingsPage } from "./pages/SettingsPage";
import { DevicePage } from "./pages/DevicePage";
import { DevicesPage } from "./pages/DevicesPage";
import { GroupsPage } from "./pages/GroupsPage";
import { SoftwarePage } from "./pages/SoftwarePage";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";
import { TokensPage } from "./pages/TokensPage";
import { PoliciesPage } from "./pages/PoliciesPage";
import { ReportsPage } from "./pages/ReportsPage";
import { AgentUpdatesPage } from "./pages/AgentUpdatesPage";
import { AccountPage } from "./pages/AccountPage";
import { SitesPage } from "./pages/SitesPage";
import { UsersPage } from "./pages/UsersPage";
import { UpdatePolicyPage } from "./pages/UpdatePolicyPage";
import { UpdatesPage } from "./pages/UpdatesPage";

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
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/enrollment" element={<TokensPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

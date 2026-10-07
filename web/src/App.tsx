import { Center, Loader } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { useSession } from "./api/session";
import { Layout } from "./components/Layout";
import { AuditPage } from "./pages/AuditPage";
import { DevicesPage } from "./pages/DevicesPage";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";
import { TokensPage } from "./pages/TokensPage";

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
        <Route path="/enrollment" element={<TokensPage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

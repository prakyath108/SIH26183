import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Layout } from "./components/Layout";
import { useAuth } from "./lib/auth";
import { EmptyState, Notice, PageHeader } from "./components/ui";
import type { Permission } from "./types";

/*
 * Every module is code-split. The heavier ones (case detail, fund flow, audit)
 * pull in table and graph machinery that a login or dashboard view never needs.
 */
const Login = lazy(() => import("./pages/Login"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Investigations = lazy(() => import("./pages/Investigations"));
const CaseDetail = lazy(() => import("./pages/CaseDetail"));
const CaseWorkspacePage = lazy(() => import("./pages/CaseWorkspacePage"));
const Explorer = lazy(() => import("./pages/Explorer"));
const FundFlow = lazy(() => import("./pages/FundFlow"));
const Vasp = lazy(() => import("./pages/Vasp"));
const Risk = lazy(() => import("./pages/Risk"));
const Alerts = lazy(() => import("./pages/Alerts"));
const Reports = lazy(() => import("./pages/Reports"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Team = lazy(() => import("./pages/Team"));
const Audit = lazy(() => import("./pages/Audit"));
const Admin = lazy(() => import("./pages/Admin"));
const NotFound = lazy(() => import("./pages/NotFound"));

function Booting(): JSX.Element {
  return (
    <div className="boot">
      <span className="spinner" />
      <p>Restoring your session…</p>
    </div>
  );
}

function Loading(): JSX.Element {
  return (
    <div className="boot">
      <span className="spinner" />
      <p>Loading…</p>
    </div>
  );
}

/** Requires a session and, optionally, specific permissions. */
function Protected({ permissions, children }: { permissions?: Permission[]; children: JSX.Element }): JSX.Element {
  const { user, loading, canAny } = useAuth();
  const location = useLocation();

  if (loading) return <Booting />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;

  // An empty array means "any signed-in user", which is how read-only roles
  // reach the modules that carry no permission gate.
  if (permissions?.length && !canAny(...permissions)) {
    return (
      <>
        <PageHeader title="Not available to your role" />
        <Notice tone="warn" title="Insufficient permissions">
          <p>
            This module requires one of: <code>{permissions.join(", ")}</code>. Your role is{" "}
            <strong>{user.role}</strong>. Ask an administrator if you believe this is wrong — permissions are enforced on
            the server, not just hidden here.
          </p>
        </Notice>
      </>
    );
  }

  return children;
}

export function App(): JSX.Element {
  const { user, loading } = useAuth();

  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route
          path="/login"
          element={loading ? <Booting /> : user ? <Navigate to="/" replace /> : <Login />}
        />

        <Route
          path="/*"
          element={
            <Protected>
              <Layout>
                <Routes>
                  <Route index element={<Dashboard />} />
                  <Route path="investigations" element={<Investigations />} />
                  <Route
                    path="investigations/:caseId"
                    element={
                      <Protected permissions={["case:read"]}>
                        <CaseDetail />
                      </Protected>
                    }
                  />
                  <Route
                    path="investigations/:caseId/workspace"
                    element={
                      <Protected permissions={["case:read"]}>
                        <CaseWorkspacePage />
                      </Protected>
                    }
                  />
                  <Route
                    path="explorer"
                    element={
                      <Protected permissions={["case:read"]}>
                        <Explorer />
                      </Protected>
                    }
                  />
                  <Route
                    path="fund-flow"
                    element={
                      <Protected permissions={["trace:run"]}>
                        <FundFlow />
                      </Protected>
                    }
                  />
                  <Route
                    path="vasp"
                    element={
                      <Protected permissions={["case:read"]}>
                        <Vasp />
                      </Protected>
                    }
                  />
                  <Route
                    path="risk"
                    element={
                      <Protected permissions={["case:read"]}>
                        <Risk />
                      </Protected>
                    }
                  />
                  <Route
                    path="alerts"
                    element={
                      <Protected permissions={["alert:read"]}>
                        <Alerts />
                      </Protected>
                    }
                  />
                  <Route
                    path="reports"
                    element={
                      <Protected permissions={["evidence:read"]}>
                        <Reports />
                      </Protected>
                    }
                  />
                  <Route
                    path="integrations"
                    element={
                      <Protected permissions={["integration:manage"]}>
                        <Integrations />
                      </Protected>
                    }
                  />
                  <Route
                    path="team"
                    element={
                      <Protected permissions={["case:read"]}>
                        <Team />
                      </Protected>
                    }
                  />
                  <Route
                    path="audit"
                    element={
                      <Protected permissions={["audit:read"]}>
                        <Audit />
                      </Protected>
                    }
                  />
                  <Route
                    path="admin"
                    element={
                      <Protected permissions={["user:manage"]}>
                        <Admin />
                      </Protected>
                    }
                  />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Layout>
            </Protected>
          }
        />
      </Routes>
    </Suspense>
  );
}

/** Used by module pages that have nothing to render before a search runs. */
export function Prompt({ children }: { children: JSX.Element }): JSX.Element {
  return <EmptyState>{children}</EmptyState>;
}

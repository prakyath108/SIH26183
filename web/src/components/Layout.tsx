import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { initials } from "../lib/format";
import { Badge, Modal, Notice, RoleBadge } from "./ui";
import type { AlertsResponse, HealthResponse, Permission } from "../types";

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Mirrors the server's PERMISSIONS map; the server still enforces every check. */
  permission?: Permission;
  badgeKey?: "alerts";
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Command",
    items: [
      { to: "/", label: "Dashboard", icon: "▦" },
      { to: "/investigations", label: "Investigations", icon: "◈", permission: "case:read" }
    ]
  },
  {
    title: "Trace",
    items: [
      { to: "/explorer", label: "Explorer", icon: "⬡", permission: "case:read" },
      { to: "/fund-flow", label: "Fund Flow", icon: "⇄", permission: "trace:run" },
      { to: "/vasp", label: "VASP Intel", icon: "⌸", permission: "case:read" }
    ]
  },
  {
    title: "Analysis",
    items: [
      { to: "/risk", label: "Risk", icon: "◐", permission: "case:read" },
      { to: "/alerts", label: "Alerts", icon: "!", badgeKey: "alerts", permission: "alert:read" }
    ]
  },
  {
    title: "Oversight",
    items: [
      { to: "/reports", label: "Reports", icon: "▣", permission: "evidence:read" },
      { to: "/integrations", label: "Integrations", icon: "⚙", permission: "integration:manage" }
    ]
  },
  {
    title: "Authority",
    items: [
      { to: "/team", label: "Team", icon: "☷", permission: "case:read" },
      { to: "/audit", label: "Auth Audit", icon: "≡", permission: "audit:read" },
      { to: "/admin", label: "Admin", icon: "⚿", permission: "user:manage" }
    ]
  }
];

/** Rank label shown under the operator name, mirroring the deployment clearance. */
const CLEARANCE: Record<string, string> = {
  admin: "L5 COMMAND",
  investigator: "L3 INVESTIGATOR",
  analyst: "L2 ANALYST",
  viewer: "L1 OBSERVER"
};

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  const { user, logout, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const health = useQuery<HealthResponse>("/api/health");
  // Only ask for the count when the user may read alerts; a 403 here would
  // otherwise surface as a silent error on every page.
  const canReadAlerts = can("alert:read");
  const alerts = useQuery<AlertsResponse>(canReadAlerts ? "/api/alerts?state=open&limit=1" : null);
  const openAlerts = alerts.data?.counts.find((c) => c.state === "open")?.n ?? 0;

  // Close the mobile drawer on navigation; otherwise it covers the new page.
  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="shell">
      <aside className={`sidebar ${navOpen ? "open" : ""}`}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            CT
          </span>
          <div className="brand-text">
            <strong>CryptoTrace AI</strong>
            <span>Forensics Module</span>
          </div>
        </div>

        <nav className="nav">
          {SECTIONS.map((section) => {
            const items = section.items.filter((i) => !i.permission || can(i.permission));
            if (!items.length) return null;
            return (
              <div key={section.title} className="nav-section">
                <span className="nav-title">{section.title}</span>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/"}
                    className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
                  >
                    <span className="nav-ico" aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className="nav-label">{item.label}</span>
                    {item.badgeKey === "alerts" && openAlerts > 0 ? (
                      <span className="nav-count" aria-label={`${openAlerts} open alerts`}>
                        {openAlerts}
                      </span>
                    ) : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <HealthLine health={health.data} />
          <button className="user-chip" onClick={() => setMenuOpen(true)}>
            <span className="avatar">{initials(user?.displayName)}</span>
            <span className="user-meta">
              <strong>{user?.displayName}</strong>
              <span>{CLEARANCE[user?.role ?? "viewer"] ?? user?.role}</span>
            </span>
          </button>
        </div>
      </aside>

      {navOpen ? <div className="scrim" onClick={() => setNavOpen(false)} /> : null}

      <div className="main">
        <header className="topbar">
          <button className="icon-btn nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Toggle navigation">
            ☰
          </button>
          <GlobalSearch />
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            <span
              className={`topbar-chip ${health.data?.status === "ok" ? "ok" : ""}`}
              title={health.data ? `${health.data.environment} · driver ${health.data.driver}` : "Checking nodes"}
            >
              Node Sync: {health.data?.status === "ok" ? "100%" : "—"}
            </span>
            {health.data?.driver ? (
              <span className="topbar-chip" title={`${health.data.environment} · driver ${health.data.driver}`}>
                {health.data.driver === "pglite" ? "Embedded DB" : "PostgreSQL"}
              </span>
            ) : null}
            <button className="user-chip compact" onClick={() => setMenuOpen(true)}>
              <span className="avatar sm">{initials(user?.displayName)}</span>
              <span className="user-meta">
                <strong>{user?.displayName}</strong>
              </span>
              <RoleBadge role={user?.role ?? "viewer"} />
            </button>
          </div>
        </header>

        <main className="content">{children}</main>
      </div>

      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title="Account">
        <div className="account">
          <div className="account-id">
            <span className="avatar lg">{initials(user?.displayName)}</span>
            <div>
              <strong>{user?.displayName}</strong>
              <span className="muted">{user?.email}</span>
              <div className="row-gap">
                <RoleBadge role={user?.role ?? "viewer"} />
                {user?.agency ? <Badge tone="neutral">{user.agency}</Badge> : null}
              </div>
            </div>
          </div>

          <div className="account-perms">
            <h4>Permissions granted to {user?.role}</h4>
            <p className="field-hint">
              Server-enforced. The UI hides what you cannot do, but the API is the authority.
            </p>
            <div className="chip-wrap">
              {(user?.permissions ?? []).map((p) => (
                <Badge key={p} tone="neutral">
                  {p}
                </Badge>
              ))}
            </div>
          </div>

          <div className="account-actions">
            <button className="btn" onClick={() => setPasswordOpen(true)}>
              Change password
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                await logout();
                // Navigation is not awaited: a rejected navigation must not be
                // mistaken for a failed sign-out.
                void navigate("/login", { replace: true });
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </Modal>

      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </div>
  );
}

function HealthLine({ health }: { health: HealthResponse | null }): JSX.Element {
  if (!health) return <span className="health muted">Checking service…</span>;
  return (
    <span className={`health ${health.status}`} title={`v${health.version} · up ${Math.round(health.uptimeSeconds)}s`}>
      <i className="dot" />
      {health.status === "ok" ? "Service healthy" : "Degraded"}
    </span>
  );
}

/**
 * Terminal-wide lookup bar. Submitting hands the identifier to the Explorer,
 * which already seeds its input from `?q=` and resolves address/tx formats.
 */
function GlobalSearch(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [term, setTerm] = useState("");
  const boxRef = useRef<HTMLInputElement>(null);

  // "/" focuses the bar, the way a terminal front-end would.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        boxRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function submit(e: FormEvent): void {
    e.preventDefault();
    const q = term.trim();
    if (!q) return;
    void navigate(`/explorer?q=${encodeURIComponent(q)}`);
    setTerm("");
  }

  return (
    <form className="search topbar-search" onSubmit={submit} role="search" key={location.pathname}>
      <span className="search-ico" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={boxRef}
        type="search"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search addresses, tx hashes, entities…"
        aria-label="Search addresses, transaction hashes, entities"
      />
    </form>
  );
}

function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [revoke, setRevoke] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
      setFieldErrors({});
      setDone(false);
    }
  }, [open]);

  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post("/api/auth/change-password", {
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revoke
      });
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError("Could not change the password.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change password"
      footer={
        done ? (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn"
              disabled={busy || mismatch || next.length < 12 || !current}
              onClick={() => void submit()}
            >
              {busy ? "Updating…" : "Update password"}
            </button>
          </>
        )
      }
    >
      {done ? (
        <Notice tone="ok" title="Password updated">
          <p>Your password has been changed{revoke ? " and other sessions have been signed out" : ""}.</p>
        </Notice>
      ) : (
        <div className="stack">
          <label className="field">
            <span className="field-label">Current password</span>
            <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            {fieldErrors.currentPassword ? <span className="field-error">{fieldErrors.currentPassword}</span> : null}
          </label>
          <label className="field">
            <span className="field-label">New password</span>
            <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            <span className="field-hint">
              At least 12 characters, with upper case, lower case and a number.
            </span>
            {fieldErrors.newPassword ? <span className="field-error">{fieldErrors.newPassword}</span> : null}
          </label>
          <label className="field">
            <span className="field-label">Confirm new password</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
            {mismatch ? <span className="field-error">Passwords do not match</span> : null}
          </label>
          <label className="check">
            <input type="checkbox" checked={revoke} onChange={(e) => setRevoke(e.target.checked)} />
            <span>Sign out my other sessions</span>
          </label>
          {error ? <Notice tone="danger">{error}</Notice> : null}
        </div>
      )}
    </Modal>
  );
}

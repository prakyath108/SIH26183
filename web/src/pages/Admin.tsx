import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { AdminUsersResponse, RiskConfigResponse, SystemResponse, UserRole } from "../types";
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  Field,
  Grid,
  isUnloaded,
  Kpi,
  KpiRow,
  Modal,
  NOT_LOADED,
  Notice,
  PageHeader,
  RoleBadge,
  Tabs
} from "../components/ui";
import { dateTime, num, relative } from "../lib/format";

const ROLES: UserRole[] = ["admin", "investigator", "analyst", "viewer"];

type Tab = "users" | "permissions" | "risk" | "system";

export default function Admin(): JSX.Element {
  const [tab, setTab] = useState<Tab>("users");
  const { can } = useAuth();

  const users = useQuery<AdminUsersResponse>(tab === "users" || tab === "permissions" ? "/api/admin/users" : null, [tab]);
  const risk = useQuery<RiskConfigResponse>(tab === "risk" ? "/api/admin/risk-config" : null, [tab]);
  const system = useQuery<SystemResponse>(tab === "system" ? "/api/admin/system" : null, [tab]);

  return (
    <>
      <PageHeader
        title="Tactical Administrative Controls"
        subtitle="Accounts, permissions, risk configuration and the state of this deployment."
        actions={
          <button className="btn" onClick={() => { users.reload(); risk.reload(); system.reload(); }}>
            Refresh
          </button>
        }
      />

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "users", label: "Users" },
          { id: "permissions", label: "Permissions" },
          { id: "risk", label: "Risk configuration" },
          { id: "system", label: "System" }
        ]}
      />

      {tab === "users" ? <UsersTab data={users} onChange={users.reload} /> : null}
      {tab === "permissions" ? <PermissionsTab data={users.data} /> : null}
      {tab === "risk" ? <RiskTab data={risk} canEdit={can("integration:manage")} /> : null}
      {tab === "system" ? <SystemTab data={system} /> : null}
    </>
  );
}

/* -------------------------------------------------------------------- users */

function UsersTab({
  data,
  onChange
}: {
  data: ReturnType<typeof useQuery<AdminUsersResponse>>;
  onChange: () => void;
}): JSX.Element {
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<AdminUsersResponse["users"][number] | null>(null);

  const active = data.data?.users.filter((u) => u.is_active).length ?? 0;
  const loaded = !isUnloaded(data);

  return (
    <>
      <KpiRow cols={4}>
        <Kpi label="Accounts" value={loaded ? num(data.data!.users.length) : NOT_LOADED} />
        <Kpi label="Active" value={loaded ? num(active) : NOT_LOADED} tone={loaded ? "ok" : undefined} />
        <Kpi label="Administrators" value={loaded ? num(data.data!.users.filter((u) => u.role === "admin").length) : NOT_LOADED} />
        <Kpi
          label="Never signed in"
          value={loaded ? num(data.data!.users.filter((u) => !u.last_login_at).length) : NOT_LOADED}
          tone={loaded && data.data!.users.some((u) => !u.last_login_at) ? "warn" : undefined}
        />
      </KpiRow>

      <Card
        title="Active User Access Directory"
        actions={
          <button className="btn primary sm" onClick={() => setCreateOpen(true)}>
            Add user
          </button>
        }
        flush
      >
        {data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : null}
        {data.error ? null : (
          <DataTable
            rows={data.data?.users ?? []}
            loading={data.loading}
            empty={loaded ? "No accounts found." : null}
          columns={[
            {
              key: "who",
              header: "User",
              render: (u) => (
                <div>
                  <span className="strong">{u.display_name}</span>
                  <div className="sub">{u.email}</div>
                </div>
              )
            },
            { key: "role", header: "Role", render: (u) => <RoleBadge role={u.role} /> },
            { key: "agency", header: "Agency", render: (u) => u.agency ?? <span className="muted">—</span> },
            {
              key: "status",
              header: "Status",
              render: (u) => <Badge tone={u.is_active ? "ok" : "neutral"}>{u.is_active ? "active" : "disabled"}</Badge>
            },
            {
              key: "load",
              header: "Workload",
              align: "right",
              render: (u) => `${num(u.assigned_cases)} assigned · ${num(u.led_cases)} leading`
            },
            {
              key: "last",
              header: "Last login",
              align: "right",
              render: (u) => (u.last_login_at ? relative(u.last_login_at) : <span className="muted">never</span>)
            },
            {
              key: "edit",
              header: "",
              align: "right",
              render: (u) => (
                <button className="btn ghost sm" onClick={() => setEditing(u)}>
                  Manage
                </button>
              )
            }
          ]}
          />
        )}
      </Card>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onDone={() => {
          setCreateOpen(false);
          toast.success("User created");
          onChange();
        }}
      />
      <EditUserModal
        user={editing}
        onClose={() => setEditing(null)}
        onDone={() => {
          setEditing(null);
          toast.success("User updated");
          onChange();
        }}
      />
    </>
  );
}

function CreateUserModal({
  open,
  onClose,
  onDone
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("analyst");
  const [agency, setAgency] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const strength = scorePassword(password);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add user"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !email || displayName.length < 2 || strength.ok === false}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setFieldErrors({});
              try {
                await api.post("/api/admin/users", {
                  email: email.trim(),
                  displayName: displayName.trim(),
                  password,
                  role,
                  agency: agency.trim() || undefined
                });
                setEmail("");
                setDisplayName("");
                setPassword("");
                setAgency("");
                onDone();
              } catch (err) {
                if (err instanceof ApiError) {
                  setError(err.message);
                  setFieldErrors(err.fieldErrors);
                } else {
                  setError("Could not create the user");
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Creating…" : "Create user"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Email" required error={fieldErrors.email}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Display name" required error={fieldErrors.displayName}>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field
          label="Initial password"
          required
          error={fieldErrors.password}
          hint="At least 12 characters with upper case, lower case and a number. Share it out of band, then have them change it."
        >
          <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className="mono" />
        </Field>
        {password ? (
          <div className={`strength ${strength.label.toLowerCase()}`}>
            <span className="strength-bar">
              <span style={{ width: `${(strength.score / 5) * 100}%` }} />
            </span>
            <span>{strength.label}</span>
          </div>
        ) : null}
        <Field label="Role" required hint="Roles carry a fixed permission set. See the Permissions tab.">
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Agency">
          <input value={agency} onChange={(e) => setAgency(e.target.value)} maxLength={200} />
        </Field>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

function scorePassword(p: string): { score: number; label: string; ok: boolean } {
  if (!p) return { score: 0, label: "", ok: true };
  let score = 0;
  if (p.length >= 12) score++;
  if (p.length >= 16) score++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) score++;
  if (/[0-9]/.test(p)) score++;
  if (/[^A-Za-z0-9]/.test(p)) score++;
  const label = ["very weak", "weak", "fair", "good", "strong", "very strong"][score] ?? "weak";
  return { score, label, ok: p.length >= 12 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) };
}

function EditUserModal({
  user,
  onClose,
  onDone
}: {
  user: AdminUsersResponse["users"][number] | null;
  onClose: () => void;
  onDone: () => void;
}): JSX.Element {
  const [role, setRole] = useState<UserRole>("analyst");
  const [isActive, setIsActive] = useState(true);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  // Seed the form from the selected user exactly once per selection.
  if (user && loaded !== user.id) {
    setLoaded(user.id);
    setRole(user.role);
    setIsActive(user.is_active);
    setPassword("");
    setError(null);
  }

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={user ? `Manage ${user.display_name}` : "Manage user"}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.patch(`/api/admin/users/${user!.id}`, {
                  role,
                  isActive,
                  ...(password ? { password } : {})
                });
                setPassword("");
                onDone();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not update the user");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <div className="stack">
        {user ? (
          <p className="muted">
            {user.email} · created {dateTime(user.created_at)} · {num(user.assigned_cases)} assigned,{" "}
            {num(user.led_cases)} leading
          </p>
        ) : null}
        <Field label="Role" required>
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </Field>
        <label className="check">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          <span>
            Account active
            <span className="field-hint">
              Deactivating revokes every refresh token immediately, so the user is signed out everywhere.
            </span>
          </span>
        </label>
        <Field
          label="Reset password"
          hint="Leave blank to keep the current password. Changing it revokes all sessions."
        >
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mono"
            placeholder="unchanged"
          />
        </Field>
        <Notice tone="warn">
          <p>
            The system refuses to demote or deactivate the last active administrator, so an instance cannot be locked out
            of its own administration.
          </p>
        </Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- permissions */

function PermissionsTab({ data }: { data: AdminUsersResponse | null }): JSX.Element {
  const [selected, setSelected] = useState<UserRole>("analyst");
  const matrix = data?.roles ?? [];

  return (
    <Grid cols={2}>
      <Card title="Advanced Role System Mapping Config" hint="What each role can do. Server-enforced on every request." flush>
        <DataTable
          rows={matrix}
          loading={!data}
          empty="No permission data."
          onRowClick={(r) => setSelected(r.role)}
          columns={[
            { key: "role", header: "Role", render: (r) => <RoleBadge role={r.role} /> },
            { key: "count", header: "Permissions", align: "right", render: (r) => num(r.permissions.length) },
            { key: "users", header: "Users", align: "right", render: (r) => num(data?.users.filter((u) => u.role === r.role).length ?? 0) }
          ]}
        />
      </Card>

      <Card title={`Permissions for ${selected}`}>
        {matrix.find((r) => r.role === selected) ? (
          <div className="chip-wrap">
            {matrix
              .find((r) => r.role === selected)!
              .permissions.map((p) => (
                <Badge key={p} tone="neutral">
                  {p}
                </Badge>
              ))}
          </div>
        ) : (
          <p className="muted">Select a role to see its permissions.</p>
        )}
        <Notice tone="info" title="Least privilege by default">
          <p>
            A viewer can read cases, entities, evidence and reports but cannot change anything. An analyst can add notes,
            run traces, collect evidence and challenge labels, but cannot close a case or manage users. Only investigators
            and administrators can close cases.
          </p>
        </Notice>
      </Card>
    </Grid>
  );
}

/* ---------------------------------------------------------------------- risk */

function RiskTab({
  data,
  canEdit
}: {
  data: ReturnType<typeof useQuery<RiskConfigResponse>>;
  canEdit: boolean;
}): JSX.Element {
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, number>>({});

  const overrides = new Map((data.data?.overrides ?? []).map((o) => [o.rule, o]));

  async function save(code: string, weight: number): Promise<void> {
    try {
      await api.put(`/api/admin/risk-config/${code}`, { weight });
      toast.success(`Weight for ${code} set to ${weight}`);
      setEdits((e) => {
        const next = { ...e };
        delete next[code];
        return next;
      });
      data.reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not save the weight");
    }
  }

  return (
    <>
      <Notice tone="warn" title="Changing weights changes every score">
        <p>
          {data.data?.notice ??
            "Risk scores prioritise review. They do not establish identity or wrongdoing and must not be presented as findings of fact."}{" "}
          Scores already stored are not recomputed automatically; re-lookup or re-trace the entities to apply new weights.
        </p>
      </Notice>

      <Card title="Thresholds" hint="The cut-offs that assign a band to a final score.">
        <div className="threshold-grid">
          {Object.entries(data.data?.thresholds ?? {}).map(([k, v]) => (
            <div key={k} className="threshold-cell">
              <span className={`pill ${k}`}>{k}</span>
              <strong>≥ {v}</strong>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Forensic Heuristics Weights" hint="Weight before the confidence discount is applied." flush>
        {data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : null}
        <table className="data">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Detection</th>
              <th className="right">Default</th>
              <th className="right">Confidence</th>
              <th className="right">Effective</th>
              <th className="right">Override</th>
              <th className="right">Set weight</th>
            </tr>
          </thead>
          <tbody>
            {(data.data?.rules ?? []).map((r) => {
              const o = overrides.get(r.code);
              const current = edits[r.code] ?? o?.weight ?? r.defaultWeight;
              return (
                <tr key={r.code}>
                  <td>
                    <div className="strong">{r.label}</div>
                    <div className="sub mono small">{r.code}</div>
                  </td>
                  <td className="small">
                    {r.detail}
                    {r.limitations ? <div className="sub">Limitation: {r.limitations}</div> : null}
                  </td>
                  <td className="right num">{r.defaultWeight}</td>
                  <td className="right num">{Math.round(r.confidence * 100)}%</td>
                  <td className="right">
                    {o ? (
                      <Badge tone="high" title={`Set by ${o.updated_by} on ${dateTime(o.updated_at)}`}>
                        {o.weight}
                      </Badge>
                    ) : (
                      <span className="muted">default</span>
                    )}
                  </td>
                  <td className="right num">
                    <strong>{current}</strong>
                  </td>
                  <td className="right">
                    {canEdit ? (
                      <div className="row-actions">
                        <input
                          type="number"
                          min={0}
                          max={100}
                          className="weight-input"
                          value={current}
                          onChange={(e) => setEdits({ ...edits, [r.code]: Number(e.target.value) })}
                        />
                        <button
                          className="btn sm"
                          disabled={current === (o?.weight ?? r.defaultWeight)}
                          onClick={() => void save(r.code, current)}
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <span className="muted">read only</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------- system */

function SystemTab({ data }: { data: ReturnType<typeof useQuery<SystemResponse>> }): JSX.Element {
  const loaded = !isUnloaded(data);

  return (
    <>
      {data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : null}

      <KpiRow cols={4}>
        <Kpi label="Runtime" value={loaded ? data.data!.runtime.node : NOT_LOADED} sub={loaded ? data.data!.runtime.env : undefined} />
        <Kpi
          label="Database driver"
          value={loaded ? data.data!.runtime.driver : NOT_LOADED}
          sub={loaded ? `up ${num(data.data!.runtime.uptimeSeconds)}s` : undefined}
        />
        <Kpi
          label="Active users"
          value={loaded ? `${data.data!.users.active} / ${data.data!.users.total}` : NOT_LOADED}
        />
        <Kpi
          label="Audit entries"
          value={loaded ? num(data.data!.audit.entries) : NOT_LOADED}
          sub={loaded && data.data!.audit.oldest ? `since ${dateTime(data.data!.audit.oldest)}` : undefined}
        />
      </KpiRow>

      {loaded ? null : (
        <Grid cols={2}>
          <Card title="Record counts" hint="Useful for spotting a deployment whose database was never migrated or seeded.">
            <table className="data dense">
              <thead>
                <tr>
                  <th>Table</th>
                  <th className="right">Rows</th>
                </tr>
              </thead>
              <tbody>
                {(data.data?.tables ?? []).map((t) => (
                  <tr key={t.table_name}>
                    <td className="mono">{t.table_name}</td>
                    <td className="right num">{num(t.n)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </Grid>
      )}

      <Grid cols={2}>
        <Card title="Record counts" hint="Useful for spotting a deployment whose database was never migrated or seeded.">
          <table className="data dense">
            <thead>
              <tr>
                <th>Table</th>
                <th className="right">Rows</th>
              </tr>
            </thead>
            <tbody>
              {(data.data?.tables ?? []).map((t) => (
                <tr key={t.table_name}>
                  <td className="mono">{t.table_name}</td>
                  <td className="right num">{num(t.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Operational notes">
          <ul className="tight small">
            <li>
              <strong>Embedded vs server database.</strong> PGlite runs the engine in-process and persists to disk; there
              is no separate service to provision. PostgreSQL is the production path.
            </li>
            <li>
              <strong>Login throttling is in-memory.</strong> It resets on restart and is per-process. Move it to a shared
              store before running more than one instance.
            </li>
            <li>
              <strong>Traces are bounded, not exhaustive.</strong> A graph that stopped at its limits is stored with those
              limits, so a result can be reproduced or challenged.
            </li>
            <li>
              <strong>No price feed is configured.</strong> USD figures are null unless you add one; the UI shows
              “not priced” rather than a zero.
            </li>
          </ul>
        </Card>
      </Grid>
    </>
  );
}

import { useState } from "react";
import { api, ApiError } from "../lib/api";
import { useQuery } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/toast";
import type { SavedSearchRow, TeamActivityResponse, TeamMembersResponse } from "../types";
import {
  Badge,
  Card,
  DataTable,
  ErrorState,
  Field,
  Grid,
  Kpi,
  KpiRow,
  Modal,
  Notice,
  PageHeader,
  RoleBadge,
  Tabs
} from "../components/ui";
import { dateTime, initials, num, relative } from "../lib/format";

type Tab = "members" | "activity" | "searches";

export default function Team(): JSX.Element {
  const { can, user } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("members");
  const [saveOpen, setSaveOpen] = useState(false);

  const members = useQuery<TeamMembersResponse>(tab === "members" ? "/api/team/members" : null, [tab]);
  const activity = useQuery<TeamActivityResponse>(tab === "activity" ? "/api/team/activity?limit=60" : null, [tab]);
  const searches = useQuery<{ searches: SavedSearchRow[] }>(tab === "searches" ? "/api/team/saved-searches" : null, [tab]);

  const active = members.data?.members.filter((m) => m.is_active).length ?? 0;
  const totalOpen = members.data?.workload.reduce((s, w) => s + w.open_cases, 0) ?? 0;
  const busiest = members.data?.workload[0];

  return (
    <>
      <PageHeader
        title="Team Forensics Directory"
        subtitle="Who works on what, and the shared state they have built up."
        actions={
          can("case:write") ? (
            <button className="btn primary" onClick={() => setSaveOpen(true)}>
              Save a search
            </button>
          ) : null
        }
      />

      <KpiRow cols={4}>
        <Kpi label="Active members" value={`${num(active)} / ${num(members.data?.members.length ?? 0)}`} />
        <Kpi label="Open cases assigned" value={num(totalOpen)} />
        <Kpi label="Busiest" value={busiest?.display_name ?? "—"} sub={busiest ? `${busiest.open_cases} open` : undefined} />
        <Kpi label="Your role" value={user?.role ?? "—"} sub={user?.agency ?? undefined} />
      </KpiRow>

      <Notice tone="info" title="A note on counts">
        <p>
          “Assigned” counts cases a member is on; “leading” counts cases where they are the lead investigator. A case can
          appear in both, so these columns are not additive.
        </p>
      </Notice>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "members", label: "Members" },
          { id: "activity", label: "Activity" },
          { id: "searches", label: "Saved searches" }
        ]}
      />

      {tab === "members" ? (
        <>
          <Grid cols={2}>
            <Card title="Active Forensics Squad" flush>
              {members.error ? <ErrorState error={members.error} onRetry={members.reload} /> : null}
              <DataTable
                rows={members.data?.members ?? []}
                loading={members.loading}
                empty="No members found."
                columns={[
                  {
                    key: "who",
                    header: "Member",
                    render: (m) => (
                      <div className="row-gap">
                        <span className="avatar sm">{initials(m.display_name)}</span>
                        <div>
                          <div className="strong">
                            {m.display_name}
                            {m.id === user?.id ? <span className="muted"> (you)</span> : null}
                          </div>
                          <div className="sub">{m.email}</div>
                        </div>
                      </div>
                    )
                  },
                  { key: "role", header: "Role", render: (m) => <RoleBadge role={m.role} /> },
                  {
                    key: "active",
                    header: "Status",
                    render: (m) => (
                      <Badge tone={m.is_active ? "ok" : "neutral"}>{m.is_active ? "active" : "disabled"}</Badge>
                    )
                  },
                  {
                    key: "last",
                    header: "Last login",
                    align: "right",
                    render: (m) => (m.last_login_at ? relative(m.last_login_at) : <span className="muted">never</span>)
                  }
                ]}
              />
            </Card>

            <Card title="Caseload" hint="Open cases per assignee. Useful for spotting overload before it becomes a bottleneck.">
              {members.data?.workload.length ? (
                <ul className="workload">
                  {members.data.workload.map((w) => (
                    <li key={w.display_name}>
                      <span className="workload-name">{w.display_name}</span>
                      <Bar value={w.open_cases} max={Math.max(1, members.data?.workload[0]?.open_cases ?? 1)} />
                      <span className="workload-value">{w.open_cases}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No workload data.</p>
              )}

              <table className="data dense">
                <thead>
                  <tr>
                    <th>Member</th>
                    <th className="right">Assigned</th>
                    <th className="right">Leading</th>
                    <th className="right">Open led</th>
                    <th className="right">Notes</th>
                    <th className="right">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {(members.data?.members ?? []).map((m) => (
                    <tr key={m.id}>
                      <td>{m.display_name}</td>
                      <td className="right num">{num(m.assigned_cases)}</td>
                      <td className="right num">{num(m.led_cases)}</td>
                      <td className="right num">{num(m.open_cases_led)}</td>
                      <td className="right num">{num(m.notes_authored)}</td>
                      <td className="right num">{num(m.evidence_collected)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </Grid>

          <Card title="Role permissions" hint="Enforced by the API, not just the interface." flush>
            <table className="data dense">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {["admin", "investigator", "analyst", "viewer"].map((r) => {
                  return (
                    <tr key={r}>
                      <td>
                        <RoleBadge role={r} />
                      </td>
                      <td className="small">
                        {r === "admin"
                          ? "Full access, including user management and risk configuration."
                          : r === "investigator"
                            ? "Create and close cases, run traces, collect and export evidence, triage alerts."
                            : r === "analyst"
                              ? "Read cases, run traces, write notes, challenge labels, collect evidence."
                              : "Read-only across cases, entities, evidence and reports."}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      ) : null}

      {tab === "activity" ? (
        <Card title="Recent team activity" hint="Successful actions only, newest first." flush>
          {activity.error ? <ErrorState error={activity.error} onRetry={activity.reload} /> : null}
          <DataTable
            rows={activity.data?.activity ?? []}
            loading={activity.loading}
            empty="No recorded activity."
            columns={[
              {
                key: "who",
                header: "Actor",
                render: (a) => (
                  <div>
                    <span>{a.actor_name ?? a.actor_email ?? "system"}</span>
                    {a.actor_role ? <div className="sub"><RoleBadge role={a.actor_role} /></div> : null}
                  </div>
                )
              },
              { key: "action", header: "Action", render: (a) => <span className="mono small">{a.action}</span> },
              { key: "entity", header: "Entity", render: (a) => <span className="small">{a.entity_type}</span> },
              {
                key: "case",
                header: "Case",
                render: (a) => (a.case_ref ? <span className="mono small">{a.case_ref}</span> : <span className="muted">—</span>)
              },
              { key: "when", header: "When", align: "right", render: (a) => dateTime(a.at) }
            ]}
          />
        </Card>
      ) : null}

      {tab === "searches" ? (
        <Card title="Saved searches" hint="Shared searches appear for the whole team; private ones only for you." flush>
          {searches.error ? <ErrorState error={searches.error} onRetry={searches.reload} /> : null}
          <DataTable
            rows={searches.data?.searches ?? []}
            loading={searches.loading}
            empty="No saved searches. Save one to keep a filter combination you return to often."
            columns={[
              { key: "name", header: "Name", render: (s) => <span className="strong">{s.name}</span> },
              { key: "query", header: "Query", render: (s) => <span className="small">{s.query}</span> },
              {
                key: "shared",
                header: "Visibility",
                render: (s) => <Badge tone={s.shared ? "info" : "neutral"}>{s.shared ? "shared" : "private"}</Badge>
              },
              { key: "owner", header: "Owner", render: (s) => s.owner ?? "—" },
              {
                key: "delete",
                header: "",
                align: "right",
                render: (s) =>
                  can("case:write") && (s.owner === user?.displayName || user?.role === "admin") ? (
                    <button
                      className="btn ghost sm"
                      onClick={async () => {
                        try {
                          await api.del(`/api/team/saved-searches/${s.id}`);
                          toast.success("Search deleted");
                          searches.reload();
                        } catch (err) {
                          toast.error(err instanceof ApiError ? err.message : "Could not delete");
                        }
                      }}
                    >
                      Delete
                    </button>
                  ) : null
              }
            ]}
          />
        </Card>
      ) : null}

      <SaveSearchModal open={saveOpen} onClose={() => setSaveOpen(false)} onSaved={() => { setSaveOpen(false); searches.reload(); setTab("searches"); }} />
    </>
  );
}

/** Simple horizontal bar used in the workload list. */
function Bar({ value, max }: { value: number; max: number }): JSX.Element {
  const width = max ? Math.round((value / max) * 100) : 0;
  return (
    <span className="mini-bar" title={`${value} open`}>
      <span style={{ width: `${width}%` }} className={value > max * 0.8 ? "hot" : ""} />
    </span>
  );
}

function SaveSearchModal({
  open,
  onClose,
  onSaved
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const toast = useToast();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save a search"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || name.trim().length < 2 || !query.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api.post("/api/team/saved-searches", {
                  name: name.trim(),
                  query: query.trim(),
                  shared
                });
                toast.success("Search saved");
                setName("");
                setQuery("");
                setShared(false);
                onSaved();
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Could not save the search");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />
        </Field>
        <Field label="Search terms or filter expression" required hint="Free text for now; stored verbatim for the team to reuse.">
          <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={2000} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>Share with the team</span>
        </label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AiPanel, CASE_APPLIED_EVENT } from "./AiPanel";
import { AnalysisPage } from "./AnalysisPage";
import { ViewerPage } from "./ViewerPage";
import { CaseStatusBadge, ChainBadge, RoleBadge } from "./ui";
import { useCaseEventStreamWS, useLocalStorage, useQuery } from "../lib/hooks";
import { getWorkflowState, WorkflowProgress } from "./WorkflowProgress";
import type { AiStatus, CaseRow, LayoutPanels } from "../types";

/**
 * Three-panel case workspace: what has been done, what the money did, and the
 * assistant.
 *
 * Panels are resizable and collapsible because the useful split differs by
 * task: reading findings wants a wide Analysis, following a hop wants the
 * graph large, and asking about one address wants the assistant open next to
 * it. The layout is persisted so the choice is not repeated every time the
 * same case is reopened.
 *
 * The three panels read the same case and the same event stream, so they cannot
 * disagree about the case's state. The AI panel is the existing case-scoped
 * `AiPanel` rather than a second chat surface, which keeps document upload,
 * indicator review and application in one place with one set of permissions.
 */

interface Props {
  case: CaseRow;
  onClose?: () => void;
}

type PanelId = "analysis" | "viewer" | "ai";

const MIN_WIDTH = 18;
const MAX_WIDTH = 62;

export function CaseWorkspace({ case: caseData, onClose }: Props): JSX.Element {
  const [widths, setWidths] = useLocalStorage<LayoutPanels["widths"]>("ct.workspace.widths", {
    analysis: 30,
    viewer: 48,
    ai: 22
  });
  const [collapsed, setCollapsed] = useLocalStorage<LayoutPanels["collapsed"]>("ct.workspace.collapsed", {
    analysis: false,
    viewer: false,
    ai: false
  });

  // Live case events over WebSocket. `caseData.status` is the value the server
  // sent with the page render; the stream keeps it current as background jobs
  // report back, so an analyst watching a long analysis sees it advance without
  // navigating away and back.
  const { status: liveStatus, connected: liveConnected } = useCaseEventStreamWS(caseData.id);
  const status = (liveStatus ?? caseData.status) as CaseRow["status"];

  // Real availability rather than an optimistic constant: an analyst who sees a
  // chat box that cannot answer has no way to tell it apart from one that is
  // merely slow.
  const ai = useQuery<AiStatus>("/api/ai/status");

  // Fetch documents to determine workflow state
  const docs = useQuery<{ documents: Array<{ id: string; status: string }> }>(`/api/ai/cases/${caseData.id}/documents`);

  // Determine workflow state for guided UI
  const workflowState = useMemo(() => getWorkflowState({
    caseStatus: status,
    documents: docs.data?.documents ?? [],
    caseId: caseData.id,
    canAnalystApprove: true // analyst can approve if they have ai:apply permission
  }), [status, docs.data?.documents, caseData.id]);

  const handleWorkflowAction = useCallback((state: ReturnType<typeof getWorkflowState>) => {
    if (state.step === "analyze_document") {
      // Focus the AI panel and trigger analyze on first extracted doc
      const aiPanel = document.querySelector('[data-ai-panel]') as HTMLElement;
      if (aiPanel) {
        const firstAnalyzeBtn = aiPanel.querySelector('button:not([disabled])') as HTMLButtonElement;
        firstAnalyzeBtn?.click();
      }
    } else if (state.step === "analyst_approve") {
      // Trigger analyst approve
      const approveBtn = document.querySelector('button[data-analyst-approve]') as HTMLButtonElement;
      approveBtn?.click();
    } else if (state.step === "upload_document") {
      // Focus file input in AI panel
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      fileInput?.click();
    }
  }, []);

  const drag = useRef<{ panel: PanelId; startX: number; startWidth: number } | null>(null);

  const setWidth = useCallback(
    (panel: PanelId, next: number) => {
      setWidths((prev) => {
        const panels: PanelId[] = ["analysis", "viewer", "ai"];
        const clamped = clamp(next, MIN_WIDTH, MAX_WIDTH);
        const others = panels.filter((p) => p !== panel);
        const total = prev[others[0]] + prev[others[1]];
        if (total <= 0) return prev;
        // The other two share whatever is left, keeping their current ratio so
        // a drag does not also rearrange them.
        const remaining = 100 - clamped;
        return {
          ...prev,
          [panel]: clamped,
          [others[0]]: +((remaining * prev[others[0]]) / total).toFixed(2),
          [others[1]]: +((remaining * prev[others[1]]) / total).toFixed(2)
        };
      });
    },
    [setWidths]
  );

  // Bound once; the handlers read `drag` and `widths` through refs/state that
  // is already current, so re-binding on every mousemove is not needed.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      setWidth(d.panel, d.startWidth + ((e.clientX - d.startX) / window.innerWidth) * 100);
    };
    const up = () => {
      drag.current = null;
      document.body.classList.remove("ws-resizing");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [setWidth]);

  const startDrag = (e: React.MouseEvent, panel: PanelId) => {
    if (collapsed[panel]) return;
    e.preventDefault();
    drag.current = { panel, startX: e.clientX, startWidth: widths[panel] };
    document.body.classList.add("ws-resizing");
  };

  const toggle = (panel: PanelId) =>
    setCollapsed((prev) => ({ ...prev, [panel]: !prev[panel] }));

  const openCount = useMemo(() => Object.values(collapsed).filter((c) => !c).length, [collapsed]);

  // Applying a proposal changes the documents, the entities, the addresses and
  // the trace, all of which the other two panels read. Bumping this key makes
  // them re-run their queries so the workspace does not keep showing the state
  // from before the apply.
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const onApplied = () => setRefreshKey((n) => n + 1);
    window.addEventListener(CASE_APPLIED_EVENT, onApplied);
    return () => window.removeEventListener(CASE_APPLIED_EVENT, onApplied);
  }, []);

  return (
    <div className="case-workspace">
      <header className="workspace-head">
        <div className="workspace-head-main">
          <h1>{caseData.case_ref}</h1>
          <CaseStatusBadge status={status} />
          {!liveConnected && <span className="ws-offline" title="Live updates disconnected">offline</span>}
          <RoleBadge role={caseData.priority} />
          <ChainBadge chain={caseData.chain} />
        </div>
        <div className="workspace-head-actions">
          {workflowState.step === "analyst_approve" && (
            <button 
              className="btn primary" 
              type="button"
              data-analyst-approve
              onClick={handleWorkflowAction.bind(null, workflowState)}
            >
              Analyst Approve & Close
            </button>
          )}
          {onClose ? (
            <button className="btn ghost" onClick={onClose} type="button">
              Back to cases
            </button>
          ) : (
            <Link className="btn ghost" to="/cases">
              Back to cases
            </Link>
          )}
        </div>
      </header>

      <WorkflowProgress 
        state={workflowState} 
        onActionClick={handleWorkflowAction} 
      />

      {openCount === 0 ? (
        <div className="workspace-all-collapsed">
          <button
            className="btn ghost sm"
            type="button"
            onClick={() => setCollapsed({ analysis: false, viewer: false, ai: false })}
          >
            Show all three panels
          </button>
        </div>
      ) : null}

      <div className="workspace-grid">
        <Panel
          id="analysis"
          title="Analysis"
          width={widths.analysis}
          collapsed={collapsed.analysis}
          onDragStart={startDrag}
          onToggle={toggle}
        >
          <AnalysisPage caseId={caseData.id} refreshKey={refreshKey} />
        </Panel>

        <Panel
          id="viewer"
          title="Viewer"
          width={widths.viewer}
          collapsed={collapsed.viewer}
          onDragStart={startDrag}
          onToggle={toggle}
        >
          <ViewerPage caseId={caseData.id} refreshKey={refreshKey} />
        </Panel>

        <Panel
          id="ai"
          title="AI Investigator"
          width={widths.ai}
          collapsed={collapsed.ai}
          onDragStart={startDrag}
          onToggle={toggle}
          badge={ai.data?.available ? undefined : "off"}
        >
          <div data-ai-panel>
            <AiPanel caseId={caseData.id} onApplied={() => setRefreshKey((n) => n + 1)} />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Panel({
  id,
  title,
  width,
  collapsed,
  badge,
  onDragStart,
  onToggle,
  children
}: {
  id: PanelId;
  title: string;
  width: number;
  collapsed: boolean;
  badge?: "off";
  onDragStart: (e: React.MouseEvent, id: PanelId) => void;
  onToggle: (id: PanelId) => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section
      className={`workspace-panel ${collapsed ? "collapsed" : ""}`}
      style={collapsed ? undefined : { flexBasis: `${width}%` }}
      aria-label={title}
    >
      <header className="workspace-panel-head">
        <button
          className="workspace-panel-toggle"
          onClick={() => onToggle(id)}
          type="button"
          aria-expanded={!collapsed}
          title={collapsed ? `Show ${title}` : `Hide ${title}`}
        >
          <span aria-hidden="true">{collapsed ? "›" : "‹"}</span>
          <span>{title}</span>
          {badge === "off" ? <span className="workspace-panel-off">off</span> : null}
        </button>
        {!collapsed ? (
          <span
            className="workspace-panel-grip"
            onMouseDown={(e) => onDragStart(e, id)}
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${title}`}
          />
        ) : null}
      </header>
      {collapsed ? null : <div className="workspace-panel-body">{children}</div>}
    </section>
  );
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export default CaseWorkspace;

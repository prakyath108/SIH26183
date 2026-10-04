import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "../lib/hooks";
import { CaseWorkspace } from "../components/CaseWorkspace";
import { ErrorState, PageHeader } from "../components/ui";
import type { CaseDetailResponse } from "../types";

/**
 * Route wrapper for the three-panel case workspace.
 *
 * The workspace is a separate route rather than a mode inside the case detail
 * page: it is a different job. The detail page is a record - entities,
 * transactions, evidence, notes - while the workspace is a working surface for
 * one case, and a long investigation should be able to keep it open while
 * moving between the two. The route also makes the workspace linkable, so a
 * colleague can be pointed at exactly the view someone else was looking at.
 */
export default function CaseWorkspacePage(): JSX.Element {
  const { caseId = "" } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useQuery<CaseDetailResponse>(
    caseId ? `/api/cases/${caseId}` : null,
    [caseId]
  );

  if (error) {
    return (
      <>
        <PageHeader title="Case workspace" />
        <ErrorState error={error} onRetry={reload} />
      </>
    );
  }

  if (loading || !data) {
    return (
      <>
        <PageHeader title="Case workspace" />
        <p className="muted">Loading case…</p>
      </>
    );
  }

  return <CaseWorkspace case={data.case} onClose={() => navigate(`/investigations/${caseId}`)} />;
}

// Workflow step definitions and helpers

export type WorkflowStep = 
  | "create_case"        // Open - just created
  | "upload_document"    // In Progress - need to upload doc
  | "analyze_document"   // In Progress - doc uploaded, need to click Read
  | "awaiting_review"    // Under Review - trace complete, awaiting analyst
  | "analyst_approve"    // Under Review - analyst needs to approve
  | "closed";            // Closed - done

export interface WorkflowState {
  step: WorkflowStep;
  label: string;
  description: string;
  actionLabel?: string;
  actionHref?: string;
  actionOnClick?: () => void;
  canAutoAdvance: boolean;
}

/** Determine workflow state from case status and document/analysis state */
export function getWorkflowState(params: {
  caseStatus: string;
  documents: Array<{ status: string; id: string }>;
  caseId: string;
  canAnalystApprove: boolean;
}): WorkflowState {
  const { caseStatus, documents, caseId, canAnalystApprove } = params;

  if (caseStatus === "Closed") {
    return {
      step: "closed",
      label: "Closed",
      description: "Case is closed. All work complete.",
      canAutoAdvance: false
    };
  }

  if (caseStatus === "Escalated") {
    return {
      step: "awaiting_review",
      label: "Escalated",
      description: "Case escalated — requires investigator review before proceeding.",
      canAutoAdvance: false
    };
  }

  if (caseStatus === "Under Review") {
    if (canAnalystApprove) {
      return {
        step: "analyst_approve",
        label: "Analyst Review",
        description: "Trace complete. Analyst review and approval needed to close case.",
        actionLabel: "Approve & Close",
        actionHref: `/api/cases/${caseId}/analyst-approve`,
        canAutoAdvance: true
      };
    }
    return {
      step: "awaiting_review",
      label: "Under Review",
      description: "Automated analysis complete. Awaiting analyst review.",
      canAutoAdvance: false
    };
  }

  if (caseStatus === "In Progress") {
    const hasExtractedDoc = documents.some(d => d.status === "extracted");
    const hasAnalyzedDoc = documents.some(d => d.status === "analyzed");
    
    if (hasAnalyzedDoc) {
      return {
        step: "awaiting_review",
        label: "Awaiting Review",
        description: "Document analyzed. Trace will run and move to Under Review.",
        canAutoAdvance: false
      };
    }
    
    if (hasExtractedDoc) {
      return {
        step: "analyze_document",
        label: "Analyze Document",
        description: "Document uploaded. Click 'Read' to analyze with AI.",
        actionLabel: "Read Document",
        // This will be handled by the AiPanel component
        canAutoAdvance: true
      };
    }
    
    return {
      step: "upload_document",
      label: "Upload Document",
      description: "Upload a PDF, CSV, or text file to begin analysis.",
      actionLabel: "Attach Document",
      canAutoAdvance: true
    };
  }

  if (caseStatus === "Open") {
    return {
      step: "upload_document",
      label: "Start Investigation",
      description: "Upload a document to begin. Case will move to In Progress automatically.",
      actionLabel: "Attach Document",
      canAutoAdvance: true
    };
  }

  return {
    step: "create_case",
    label: "New Case",
    description: "Case created. Upload a document to begin.",
    actionLabel: "Attach Document",
    canAutoAdvance: true
  };
}

/** Render workflow progress indicator */
export function WorkflowProgress({ 
  state, 
  onActionClick 
}: { 
  state: WorkflowState; 
  onActionClick?: (state: WorkflowState) => void;
}): JSX.Element {
  const steps: Array<{ key: WorkflowStep; label: string }> = [
    { key: "create_case", label: "Create" },
    { key: "upload_document", label: "Upload" },
    { key: "analyze_document", label: "Analyze" },
    { key: "awaiting_review", label: "Review" },
    { key: "analyst_approve", label: "Approve" },
    { key: "closed", label: "Closed" }
  ];

  const currentIndex = steps.findIndex(s => s.key === state.step);
  
  return (
    <div className="workflow-progress">
      <div className="workflow-steps">
        {steps.map((step, i) => {
          const isCurrent = i === currentIndex;
          const isComplete = i < currentIndex;
          
          return (
            <div key={step.key} className={`workflow-step ${isCurrent ? "current" : ""} ${isComplete ? "complete" : ""}`}>
              <div className="workflow-step-circle">
                {isComplete ? "✓" : i + 1}
              </div>
              <span className="workflow-step-label">{step.label}</span>
              {i < steps.length - 1 && <span className="workflow-connector" />}
            </div>
          );
        })}
      </div>
      <div className="workflow-current">
        <strong>{state.label}</strong>
        <span>{state.description}</span>
        {state.actionLabel && state.canAutoAdvance && (
          <button 
            className="btn primary workflow-action-btn"
            onClick={() => onActionClick?.(state)}
            type="button"
          >
            {state.actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
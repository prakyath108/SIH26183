import { describe, it, expect } from "vitest";
import { determineStatus } from "./engine.js";
import type { CaseEvent, StatusDecision } from "./engine.js";

const TEST_CASE_ID = "00000000-0000-0000-0000-000000000001";
const TEST_ACTOR = "00000000-0000-0000-0000-000000000002";

function statusOf(decision: StatusDecision): string {
  return decision.status;
}

function traceStarted(): CaseEvent {
  return { type: "TRACE_STARTED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, traceJobId: "job-1" };
}

function traceCompleted(): CaseEvent {
  return { type: "TRACE_COMPLETED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, traceJobId: "job-1", traceId: "trace-1" };
}

function riskAnalysisCompleted(): CaseEvent {
  return { type: "RISK_ANALYSIS_COMPLETED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR };
}

function alertCreated(): CaseEvent {
  return { type: "ALERT_CREATED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, alertId: "alert-1", severity: "medium" };
}

function criticalAlertCreated(): CaseEvent {
  return { type: "CRITICAL_ALERT_CREATED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, alertId: "alert-1", reason: "test" };
}

function reviewStarted(): CaseEvent {
  return { type: "REVIEW_STARTED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR };
}

function escalationRequired(): CaseEvent {
  return { type: "ESCALATION_REQUIRED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, reason: "test" };
}

function escalationResolved(): CaseEvent {
  return { type: "ESCALATION_RESOLVED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, reason: "test" };
}

function caseApproved(): CaseEvent {
  return { type: "CASE_APPROVED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, closureNote: "explicit closure override by investigator" };
}

function caseReopened(): CaseEvent {
  return { type: "CASE_REOPENED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, reason: "new evidence" };
}

function aiAnalysisStarted(): CaseEvent {
  return { type: "AI_ANALYSIS_STARTED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR };
}

function aiAnalysisCompleted(): CaseEvent {
  return { type: "AI_ANALYSIS_COMPLETED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, proposalId: "prop-1" };
}

function aiApplyStarted(): CaseEvent {
  return { type: "AI_APPLY_STARTED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, proposalId: "prop-1" };
}

function aiApplyCompleted(): CaseEvent {
  return { type: "AI_APPLY_COMPLETED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR, proposalId: "prop-1" };
}

function documentUploaded(): CaseEvent {
  return { type: "DOCUMENT_UPLOADED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR };
}

function textExtracted(): CaseEvent {
  return { type: "TEXT_EXTRACTED", caseId: TEST_CASE_ID, actorId: TEST_ACTOR };
}

describe("determineStatus", () => {
  it("Open -> TRACE_STARTED -> In Progress", () => {
    expect(statusOf(determineStatus("Open", traceStarted()))).toBe("In Progress");
  });

  it("In Progress -> RISK_ANALYSIS_COMPLETED -> Under Review", () => {
    expect(statusOf(determineStatus("In Progress", riskAnalysisCompleted()))).toBe("Under Review");
  });

  it("Under Review -> CRITICAL_ALERT_CREATED -> Escalated", () => {
    expect(statusOf(determineStatus("Under Review", criticalAlertCreated()))).toBe("Escalated");
  });

  it("Under Review -> ESCALATION_REQUIRED -> Escalated", () => {
    expect(statusOf(determineStatus("Under Review", escalationRequired()))).toBe("Escalated");
  });

  it("Escalated -> ESCALATION_RESOLVED -> Under Review", () => {
    expect(statusOf(determineStatus("Escalated", escalationResolved()))).toBe("Under Review");
  });

  it("Escalated -> ESCALATION_REQUIRED again -> Escalated (no change)", () => {
    expect(statusOf(determineStatus("Escalated", escalationRequired()))).toBe("Escalated");
  });

  it("Under Review -> CASE_APPROVED with closureNote -> Closed", () => {
    expect(statusOf(determineStatus("Under Review", caseApproved()))).toBe("Closed");
  });

  it("Closed is inert to completion events", () => {
    expect(statusOf(determineStatus("Closed", traceCompleted()))).toBe("Closed");
  });

  it("Closed -> CASE_REOPENED -> Open", () => {
    expect(statusOf(determineStatus("Closed", caseReopened()))).toBe("Open");
  });

  it("NON_TRANSITIONING events never change status", () => {
    for (const ev of [documentUploaded(), textExtracted()]) {
      expect(statusOf(determineStatus("Under Review", ev))).toBe("Under Review");
    }
  });

  it("COMPLETION_EVENTS from In Progress produce Under Review", () => {
    for (const ev of [traceCompleted(), riskAnalysisCompleted(), alertCreated(), aiAnalysisCompleted(), aiApplyCompleted()]) {
      expect(statusOf(determineStatus("In Progress", ev))).toBe("Under Review");
    }
  });

  it("COMPLETION_EVENTS from Under Review produce Under Review", () => {
    for (const ev of [traceCompleted(), riskAnalysisCompleted(), alertCreated(), aiAnalysisCompleted(), aiApplyCompleted()]) {
      expect(statusOf(determineStatus("Under Review", ev))).toBe("Under Review");
    }
  });

  it("ESCALATION_REQUIRED from Escalated is idempotent", () => {
    expect(statusOf(determineStatus("Escalated", escalationRequired()))).toBe("Escalated");
  });

  it("ESCALATION_RESOLVED from Under Review stays Under Review", () => {
    expect(statusOf(determineStatus("Under Review", escalationResolved()))).toBe("Under Review");
  });

  it("REVIEW_STARTED is a COMPLETION_EVENT: from Open stays Open, from In Progress/Under Review -> Under Review", () => {
    expect(statusOf(determineStatus("Open", reviewStarted()))).toBe("Open"); // Not in START_EVENTS
    expect(statusOf(determineStatus("In Progress", reviewStarted()))).toBe("Under Review");
    expect(statusOf(determineStatus("Under Review", reviewStarted()))).toBe("Under Review");
    // From Escalated, the escalation check at line 152 fires first
    expect(statusOf(determineStatus("Escalated", reviewStarted()))).toBe("Escalated");
    // From Closed, the Closed check at line 108 fires first
    expect(statusOf(determineStatus("Closed", reviewStarted()))).toBe("Closed");
  });

  it("START_EVENTS from Open produce In Progress", () => {
    for (const ev of [traceStarted(), aiAnalysisStarted(), aiApplyStarted()]) {
      expect(statusOf(determineStatus("Open", ev))).toBe("In Progress");
    }
  });

  it("START_EVENTS from In Progress produce In Progress", () => {
    for (const ev of [traceStarted(), aiAnalysisStarted(), aiApplyStarted()]) {
      expect(statusOf(determineStatus("In Progress", ev))).toBe("In Progress");
    }
  });
});
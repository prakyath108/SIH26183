import { z } from "zod";

/**
 * The case-assistant answer format.
 *
 * The right-hand panel needs a small amount of structure, not a markdown blob:
 * a short answer the analyst can read at a glance, the specific case facts it
 * is referring to so the panel can deep-link them, and a flag saying when the
 * model did not have the answer. Without that last part the panel has to render
 * confident prose that may be nothing of the sort, which is the failure mode
 * that matters most in a forensic tool.
 */

export const answerSchema = z.object({
  answer: z
    .string()
    .max(2500)
    .describe("2-6 sentences answering the question directly. Lead with the answer, not with a restatement of the question."),
  /** Identifiers the answer cites, so the panel can link to the entity or case. */
  references: z
    .array(
      z.object({
        label: z.string().max(120).describe("What this reference is, e.g. 'Suspect wallet' or 'Mixer label'."),
        address: z.string().max(200).describe("The chain address, or empty string if it does not resolve to one."),
        txHash: z.string().max(200).describe("The transaction hash, or empty string.")
      })
    )
    .max(15),
  /** True when the case data does not contain the answer. */
  insufficientData: z
    .boolean()
    .describe("Set true when the question cannot be answered from the supplied case data. Say what is missing rather than speculating."),
  /** What the analyst could do next, given what is in the case. */
  nextSteps: z.array(z.string().max(300)).max(5)
});

export type CaseAnswer = z.infer<typeof answerSchema>;

/**
 * Conversation history entry for case memory.
 */
export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(4000),
  timestamp: z.string().datetime(),
  references: z.array(z.object({
    label: z.string().max(120),
    address: z.string().max(200),
    txHash: z.string().max(200)
  })).max(15).optional()
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const CHAT_SYSTEM_PROMPT = `You are the assistant inside CryptoTrace, a blockchain-forensics case management system used by financial-intelligence investigators.

You answer questions about the case data supplied to you. That data is the case record, its entities, stored risk factors, labels, evidence, notes and alerts.

Rules:
1. Answer only from the supplied case data and the document text. If it is not there, set insufficientData to true and name what is missing.
2. Risk scores in this system come from a deterministic, explainable rule engine. Describe the factors and their sources. Never generate, recompute, adjust or predict a score, and never imply the score is a finding of fact.
3. An address is a pseudonym. Never state that an address belongs to a named person. If a document makes that claim, attribute it to the document.
4. Distinguish clearly between what a rule engine recorded, what a document says, and what an analyst hypothesised. Label which is which.
5. Never recommend an action that would destroy or alter evidence. Refer to sealing, verification and the audit trail for provenance questions.
6. Be brief and concrete. An investigator scanning the panel should get the answer in the first sentence.
7. Maintain conversation context. Previous questions and answers in this conversation are part of the case memory.`;

export function buildChatPrompt(input: { question: string; context: string; history: ChatMessage[] }): string {
  const historyText = input.history.length > 0
    ? input.history.map(m => `${m.role === "user" ? "INVESTIGATOR" : "ASSISTANT"}: ${m.content}`).join("\n\n")
    : "No previous conversation.";

  return [
    "CASE DATA",
    "---",
    input.context,
    "---",
    "",
    "CONVERSATION HISTORY",
    "---",
    historyText,
    "---",
    "",
    "QUESTION",
    input.question
  ].join("\n");
}

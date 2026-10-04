import OpenAI from "openai";
import { z } from "zod";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { badRequest, tooManyRequests, unavailable, type HttpError } from "../middleware/error.js";

/**
 * OpenAI access for document analysis.
 *
 * Two design constraints come from the rest of the codebase:
 *
 *  1. **Nothing is written by a model.** This module returns parsed data for a
 *     human to approve. The risk engine stays the only thing that computes a
 *     score (`server/src/risk/engine.ts`). A model never emits a risk level.
 *  2. **Absence degrades, it does not crash.** With no key every call throws a
 *     typed error the routes turn into a 503, matching the keyless-tier
 *     behaviour the chain adapters already have.
 *
 * Extraction runs against a JSON schema rather than free prose so a response is
 * validated before it can reach a reviewer. `temperature: 0` because this is
 * transcription work, not generation: the same document should always yield the
 * same proposal.
 */

let client: OpenAI | null = null;
let inflight = 0;

export function isAiAvailable(): boolean {
  return env.aiAvailable;
}

function getClient(): OpenAI {
  if (!env.aiAvailable) {
    // 503, not 400: the request was well-formed, the deployment just has no
    // provider configured. The UI reads this code to hide the panel instead of
    // showing an error the user cannot act on.
    throw unavailable(
      !env.AI_ENABLED
        ? "AI analysis is disabled by configuration (AI_ENABLED=false)."
        : "AI analysis is unavailable: no OPENAI_API_KEY is configured.",
      "ai_unavailable"
    );
  }
  if (!client) {
    client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
      // Bound every call independently of the caller's own timeout, so a
      // dropped request cannot leave a socket open against the provider.
      timeout: env.AI_TIMEOUT_MS,
      maxRetries: 2
    });
  }
  return client;
}

/**
 * Concurrency gate. Without it, N analysts uploading at once becomes N
 * simultaneous long-context calls, which is both a spend problem and a good way
 * to get rate-limited into a burst of 500s.
 */
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inflight >= env.AI_MAX_CONCURRENT) {
    throw tooManyRequests(
      `AI analysis is at capacity (${env.AI_MAX_CONCURRENT} concurrent). Try again in a moment.`,
      "ai_at_capacity"
    );
  }
  inflight += 1;
  try {
    return await fn();
  } finally {
    inflight -= 1;
  }
}

export interface StructuredCall<T> {
  system: string;
  user: string;
  /** zod schema the response must satisfy. */
  schema: z.ZodType<T>;
  /** Human-readable name, used in error messages and the audit trail. */
  label: string;
  maxOutputTokens?: number;
}

/** HTTP status carried by a provider SDK error, or NaN when there isn't one. */
function providerStatus(err: unknown): number {
  if (typeof err !== "object" || err === null || !("status" in err)) return NaN;
  const raw = (err as { status?: unknown }).status;
  return typeof raw === "number" ? raw : NaN;
}

/**
 * Turn a provider failure into something an operator can act on.
 *
 * Unhandled, these reach the generic error middleware and come back as
 * "An unexpected error occurred", which is true but useless: a rejected key, a
 * wrong model name and an exhausted quota are all indistinguishable from the
 * outside, and all three are configuration or upstream problems rather than
 * faults in this service. Returns null when the error is not recognisably the
 * provider's, so the caller rethrows the original.
 */
function providerError(err: unknown): HttpError | null {
  const status = providerStatus(err);
  const endpointHint = env.OPENAI_BASE_URL ? " and OPENAI_BASE_URL" : "";

  if (status === 401 || status === 403) {
    return unavailable(
      `The AI provider rejected the configured credentials (HTTP ${status}). Check OPENAI_API_KEY${endpointHint}.`,
      "ai_provider_unauthorized"
    );
  }
  if (status === 404) {
    return unavailable(
      `The AI provider has no model named "${env.OPENAI_MODEL}" (HTTP 404). Check OPENAI_MODEL${endpointHint}.`,
      "ai_provider_model_not_found"
    );
  }
  if (status === 429) {
    return unavailable(
      "The AI provider refused the request for rate or quota reasons (HTTP 429).",
      "ai_provider_throttled"
    );
  }
  if (status >= 500) {
    return unavailable(`The AI provider is unavailable (HTTP ${status}).`, "ai_provider_unavailable");
  }
  return null;
}

/**
 * Call the model and return a schema-validated object.
 *
 * `strict` JSON schema mode is the reason this is worth a wrapper: the provider
 * constrains the response shape itself, so a malformed or truncated reply is
 * rejected by the API rather than surfacing as a parse error after the tokens
 * have already been billed.
 */
export async function callStructured<T>(call: StructuredCall<T>): Promise<T> {
  return withSlot(async () => {
    const api = getClient();
    const started = Date.now();

    // zod -> JSON Schema. `zod-to-json-schema` is not a dependency; the handful
    // of shapes used here are described directly so the strict-mode constraints
    // (required + additionalProperties:false) are explicit and reviewable.
    const jsonSchema = toJsonSchema(call.schema);

    // Try structured output first (OpenAI native). If it fails (e.g., OpenRouter
    // models that don't support json_schema), fall back to manual JSON extraction.
    let response;
    let usedStructuredOutput = false;
    try {
      response = await api.chat.completions.create({
        model: env.OPENAI_MODEL,
        temperature: 0,
        max_tokens: call.maxOutputTokens ?? 4_096,
        response_format: {
          type: "json_schema",
          json_schema: { name: call.label, strict: true, schema: jsonSchema }
        },
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user }
        ]
      });
      usedStructuredOutput = true;
    } catch (structuredErr) {
      // Only a rejection of the request *shape* justifies dropping structured
      // output. Retrying without it after a 401/403/429/5xx spends a second
      // call to reach the same failure and buries the real cause behind a
      // misleading "structured output unavailable" warning.
      const status = providerStatus(structuredErr);
      const shapeRejected = Number.isNaN(status) || status === 400 || status === 404 || status === 422;
      if (!shapeRejected) throw providerError(structuredErr) ?? structuredErr;

      // Fall back to manual JSON extraction for providers that don't support
      // structured output (e.g., most OpenRouter models). We inject the schema
      // into the system prompt and parse the JSON manually.
      logger.warn("Structured output unavailable, falling back to manual JSON", {
        model: env.OPENAI_MODEL,
        error: structuredErr instanceof Error ? structuredErr.message : String(structuredErr)
      });
      try {
        response = await api.chat.completions.create({
          model: env.OPENAI_MODEL,
          temperature: 0,
          max_tokens: call.maxOutputTokens ?? 4_096,
          messages: [
            {
              role: "system",
              content:
                call.system +
                "\n\nIMPORTANT: You must respond with ONLY a valid JSON object that matches this schema:\n" +
                JSON.stringify(jsonSchema, null, 2)
            },
            { role: "user", content: call.user }
          ]
        });
      } catch (fallbackErr) {
        // The fallback is a second attempt at the same endpoint, so it fails
        // for the same reason. Surface that reason, not a parse error.
        throw providerError(fallbackErr) ?? fallbackErr;
      }
    }

    const message = response.choices[0]?.message;
    const raw = message?.content;
    if (!raw) {
      const refusal = message?.refusal;
      throw badRequest(
        refusal
          ? `The model declined to analyse this document: ${refusal}`
          : "The model returned an empty response."
      );
    }

    let parsed: unknown;
    try {
      // If we used structured output, the response should already be valid JSON.
      // If we fell back, we need to extract JSON from the response.
      parsed = JSON.parse(raw);
    } catch {
      // Try to extract JSON from markdown code blocks or surrounding text
      const jsonMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
        } catch {
          throw badRequest("The model returned a response that was not valid JSON.");
        }
      } else {
        throw badRequest("The model returned a response that was not valid JSON.");
      }
    }

    const result = call.schema.safeParse(parsed);
    if (!result.success) {
      logger.warn("AI response failed schema validation", {
        label: call.label,
        issues: result.error.issues.slice(0, 5)
      });
      throw badRequest("The model's response did not match the expected structure. Try again.");
    }

    logger.info("AI call completed", {
      label: call.label,
      model: env.OPENAI_MODEL,
      ms: Date.now() - started,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      usedStructuredOutput
    });
    return result.data;
  });
}

/**
 * Minimal zod -> JSON Schema for the subset used by the AI schemas.
 *
 * The provider's strict mode requires `additionalProperties: false` and an
 * explicit `required` list on every object, and it does not support every JSON
 * Schema keyword. Rather than pull in a general converter, this handles the
 * node types the proposal schemas actually use and throws on anything else, so
 * an unsupported schema fails loudly at development time instead of being
 * silently under-constrained in production.
 */
type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName?: string; innerType?: z.ZodTypeAny; type?: z.ZodTypeAny; values?: unknown[]; checks?: unknown[] };

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const obj = schema as unknown as z.ZodObject<z.ZodRawShape>;
      const shape = obj.shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        // Every field is required in strict mode. Optionality is expressed by
        // widening the type (e.g. `z.string().nullable()`) rather than by
        // omitting the key, which strict mode disallows.
        required.push(key);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }

    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: "array", items: toJsonSchema((schema as unknown as z.ZodArray<z.ZodTypeAny>).element) };

    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: [...((schema as unknown as z.ZodEnum<[string, ...string[]]>).options as string[])] };

    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { type: "string", const: (schema as unknown as z.ZodLiteral<string>).value };

    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodOptional:
      // An optional field is emitted as nullable so the key stays required.
      return { anyOf: [toJsonSchema(def.innerType!), { type: "null" }] };

    case z.ZodFirstPartyTypeKind.ZodNumber:
    case z.ZodFirstPartyTypeKind.ZodBigInt:
      return { type: "number" };

    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };

    case z.ZodFirstPartyTypeKind.ZodString:
    case z.ZodFirstPartyTypeKind.ZodDate:
    case z.ZodFirstPartyTypeKind.ZodUnknown:
    case z.ZodFirstPartyTypeKind.ZodAny:
      return { type: "string" };

    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const options = (schema as unknown as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options;
      return { anyOf: options.map(toJsonSchema) };
    }

    case z.ZodFirstPartyTypeKind.ZodRecord:
      return { type: "object", additionalProperties: true };

    default:
      throw new Error(
        `toJsonSchema: unsupported zod type "${def.typeName ?? "unknown"}". Add it explicitly rather than letting the model return an unconstrained shape.`
      );
  }
}

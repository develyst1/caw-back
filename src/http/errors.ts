import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { BlueprintUnreachable } from "../blueprint/client";

// One error body everywhere (SPEC-A-008 § API): { error: { code, message, details? } }, as blueprint-back.
export const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
}).openapi("Error");

const errorContent = (description: string) => ({ description, content: { "application/json": { schema: ErrorBody } } });

// Error responses for route definitions, so the OpenAPI document shows them.
export const errors = {
  400: errorContent("validation · actor_required · unknown_worker · anchor_required · not_a_member · not_a_question · hop_required"),
  403: errorContent("operator_only · not_your_card · not_your_message"),
  404: errorContent("not_found · blueprint_project_not_found"),
  409: errorContent("version_not_confirmed · already_exists · name_taken · already_member · edge_exists · is_entry · has_open_cards · chain_broken · waiting_on_question · already_answered · hop_not_running · worker_in_chain · hop_running"),
  422: errorContent("anchor_not_in_version · version_not_confirmed · anchor_not_located"),
  502: errorContent("blueprint_unreachable"),
} as const;

/** A request the API refuses, with the code, status and details the SPEC names. */
export class ApiError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 422 | 502, readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

const body = (code: string, message: string, details?: Record<string, unknown>) => ({ error: { code, message, ...(details ? { details } : {}) } });

// Request validation (body, params, query) → 400 in the same shape as every other error.
export function validationHook(result: { success: boolean; error?: unknown }, c: Context) {
  if (!result.success) return c.json(body("validation", z.prettifyError(result.error as z.ZodError)), 400);
}

// An unknown path or method answers in the same shape as every other error.
export function unknownRoute(c: Context) {
  return c.json(body("not_found", `no route ${c.req.method} ${c.req.path}`), 404);
}

export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json(body(err.code, err.message, err.details), err.status);
  if (err instanceof BlueprintUnreachable) return c.json(body("blueprint_unreachable", err.message), 502);
  if (err instanceof z.ZodError) return c.json(body("validation", z.prettifyError(err)), 400);
  // Request faults Hono raises itself (a body that is not JSON) are bad input: 400.
  if (err instanceof HTTPException && err.status < 500) return c.json(body("validation", `${err.message} — send the body as application/json`), 400);
  // Name and code only: a database error's message and params can hold document text.
  const code = (err as { cause?: { code?: string } }).cause?.code;
  console.error(`[http] 500 ${err.name}${code ? ` code=${code}` : ""}`);
  return c.json(body("internal", "something went wrong on the server"), 500);
}

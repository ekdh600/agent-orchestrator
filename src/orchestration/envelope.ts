import crypto from "node:crypto";

/**
 * Message envelope for worker request/response exchanges.
 *
 * The transport (a one-shot subprocess's stdin/stdout) cannot lose or reorder
 * messages, so there is no ack/retransmit machinery here. What CAN go wrong:
 *   - the model prints a JSON object that is NOT a response to this request
 *     (e.g. it copies an example from the prompt) and extractJson() happily
 *     consumes it;
 *   - an artifact from a previous round gets fed into a later round's prompt.
 *
 * The envelope addresses both: every worker call gets an `exchange_id`;
 * JSON-producing stages (plan / review / decompose / …) must echo it at the
 * top level of their output, and the orchestrator refuses payloads whose echo
 * is missing or wrong (one retry, then the payload is discarded). JSON
 * artifacts are stamped with `_meta` binding them to {runId, round, exchangeId}.
 *
 * File-editing stages (implement / repair) return work via `git diff`, not
 * JSON — for those the envelope is correlation-only (no echo contract).
 */

export interface ArtifactMeta {
  runId: string;
  round: number | null;
  exchangeId: string;
}

export const EXCHANGE_ID_FIELD = "exchange_id";

/**
 * Build a human-readable exchange id, e.g. `20260611-072145-r2-review-k3f9`.
 * `qualifier` distinguishes parallel exchanges in the same stage/round
 * (e.g. a review-panel perspective name).
 */
export function makeExchangeId(
  runId: string,
  stage: string,
  round?: number | null,
  qualifier?: string,
): string {
  const runShort = runId.slice(0, 15); // "YYYYMMDD-HHMMSS"
  const rand = crypto.randomBytes(2).toString("hex");
  const parts = [runShort, ...(round != null ? [`r${round}`] : []), stage, ...(qualifier ? [qualifier] : []), rand];
  return parts.join("-");
}

/**
 * Render the envelope block appended to a worker prompt.
 * `echoRequired` is set for JSON-producing stages only.
 */
export function renderEnvelope(exchangeId: string, opts: { echoRequired: boolean }): string {
  const lines = [
    "## Message envelope",
    "",
    `${EXCHANGE_ID_FIELD}: ${exchangeId}`,
    "",
  ];
  if (opts.echoRequired) {
    lines.push(
      `Your output JSON object MUST include the top-level field "${EXCHANGE_ID_FIELD}" set to exactly "${exchangeId}".`,
      "This lets the orchestrator verify that the JSON it parses is the response to THIS request and not e.g. an example copied from this prompt.",
      "Do not output any other JSON object before or after your response.",
    );
  } else {
    lines.push(
      "This identifier is used to correlate this request in the orchestrator's audit logs.",
      "You do not need to echo it anywhere.",
    );
  }
  return lines.join("\n");
}

/** Stronger reminder appended on the single retry after a failed echo check. */
export function renderEchoRetryReminder(exchangeId: string): string {
  return [
    "## IMPORTANT — previous response rejected",
    "",
    `Your previous response was rejected because it did not echo the required "${EXCHANGE_ID_FIELD}".`,
    `Respond again with ONE JSON object whose top-level "${EXCHANGE_ID_FIELD}" field is exactly "${exchangeId}".`,
  ].join("\n");
}

/** True when the parsed payload correctly echoes the expected exchange id. */
export function verifyEcho(payload: unknown, exchangeId: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as Record<string, unknown>)[EXCHANGE_ID_FIELD] === exchangeId;
}

/** Remove the echoed exchange_id before the payload becomes an artifact. */
export function stripEcho<T>(payload: T): T {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const copy = { ...(payload as Record<string, unknown>) };
    delete copy[EXCHANGE_ID_FIELD];
    return copy as T;
  }
  return payload;
}

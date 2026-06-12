import { describe, it, expect } from "vitest";
import {
  EXCHANGE_ID_FIELD,
  makeExchangeId,
  renderEnvelope,
  renderEchoRetryReminder,
  stripEcho,
  verifyEcho,
} from "../src/orchestration/envelope.js";

describe("makeExchangeId", () => {
  it("builds a readable id from runId / round / stage / qualifier", () => {
    const id = makeExchangeId("20260611-072145-some-task", "review", 2, "security");
    expect(id).toMatch(/^20260611-072145-r2-review-security-[a-z0-9]{4}$/);
  });

  it("omits round and qualifier when absent", () => {
    const id = makeExchangeId("20260611-072145-some-task", "plan");
    expect(id).toMatch(/^20260611-072145-plan-[a-z0-9]{4}$/);
  });

  it("produces unique ids for identical inputs", () => {
    const a = makeExchangeId("20260611-072145-x", "plan");
    const b = makeExchangeId("20260611-072145-x", "plan");
    expect(a).not.toBe(b);
  });
});

describe("renderEnvelope", () => {
  it("includes the echo contract for JSON stages", () => {
    const text = renderEnvelope("abc-plan-1234", { echoRequired: true });
    expect(text).toContain("exchange_id: abc-plan-1234");
    expect(text).toContain('"exchange_id"');
    expect(text).toContain("MUST");
  });

  it("marks correlation-only envelopes as not requiring an echo", () => {
    const text = renderEnvelope("abc-implement-1234", { echoRequired: false });
    expect(text).toContain("exchange_id: abc-implement-1234");
    expect(text).toContain("do not need to echo");
  });

  it("retry reminder names the expected id", () => {
    expect(renderEchoRetryReminder("abc-1")).toContain('"exchange_id"');
    expect(renderEchoRetryReminder("abc-1")).toContain("abc-1");
  });
});

describe("verifyEcho / stripEcho", () => {
  it("accepts a payload echoing the exact id", () => {
    expect(verifyEcho({ [EXCHANGE_ID_FIELD]: "id-1", verdict: "approve" }, "id-1")).toBe(true);
  });

  it("rejects missing, wrong, or non-object payloads", () => {
    expect(verifyEcho({ verdict: "approve" }, "id-1")).toBe(false);
    expect(verifyEcho({ [EXCHANGE_ID_FIELD]: "id-2" }, "id-1")).toBe(false);
    expect(verifyEcho(null, "id-1")).toBe(false);
    expect(verifyEcho("id-1", "id-1")).toBe(false);
  });

  it("stripEcho removes only the exchange_id field", () => {
    const stripped = stripEcho({ [EXCHANGE_ID_FIELD]: "id-1", verdict: "approve" });
    expect(stripped).toEqual({ verdict: "approve" });
    // non-objects pass through untouched
    expect(stripEcho(null)).toBe(null);
  });
});

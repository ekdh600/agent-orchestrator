import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ConversationLog, renderTranscript } from "../src/orchestration/conversationLog.js";
import { EventBus } from "../src/orchestration/eventBus.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ao-conv-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ConversationLog", () => {
  it("appends events as JSONL with redacted content", async () => {
    await withTempDir(async (dir) => {
      const log = ConversationLog.forRun(dir);
      await log.status("plan", "starting plan");
      await log.prompt({
        stage: "plan",
        actor: "claude",
        content: "API key is sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa here",
      });
      await log.response({
        stage: "plan",
        actor: "claude",
        content: '{"summary":"ok"}',
        durationMs: 12,
        exitCode: 0,
      });
      await log.verifierCommand(1, "npm test");
      await log.verifierOutput({
        round: 1,
        command: "npm test",
        exitCode: 0,
        durationMs: 200,
        tail: "all good",
      });

      const raw = await readFile(path.join(dir, "conversation.jsonl"), "utf8");
      const lines = raw.trim().split("\n");
      expect(lines.length).toBe(5);

      const events = lines.map((l) => JSON.parse(l));
      // monotonic per-run seq, present on every persisted event
      expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
      expect(events[0].kind).toBe("status");
      expect(events[1].kind).toBe("prompt");
      expect(events[1].content).not.toContain("sk-ant-aaaa"); // redacted
      expect(events[1].content).toContain("[REDACTED:");
      expect(events[2].kind).toBe("response");
      expect(events[2].durationMs).toBe(12);
      expect(events[3].kind).toBe("verifier_command");
      expect(events[4].kind).toBe("verifier_output");
    });
  });

  it("publishes events onto an attached bus and persists the bus-issued seq", async () => {
    await withTempDir(async (dir) => {
      const bus = new EventBus();
      const topic = "run:test";
      // Something else already published on the topic — the log must continue
      // the bus's numbering, not start its own at 0.
      bus.publish(topic, { type: "progress", event: { kind: "status" } });

      const seen: number[] = [];
      bus.subscribe(topic, (e) => {
        const payload = e.payload as { type?: string };
        if (payload?.type === "conversation") seen.push(e.seq);
      });

      const log = ConversationLog.forRun(dir, bus, topic);
      await log.status("plan", "starting plan");
      await log.prompt({ stage: "plan", actor: "claude", content: "hi", meta: { exchangeId: "x-1" } });

      const raw = await readFile(path.join(dir, "conversation.jsonl"), "utf8");
      const events = raw.trim().split("\n").map((l) => JSON.parse(l));
      expect(events.map((e) => e.seq)).toEqual([1, 2]); // bus seq 0 was the progress event
      expect(events[1].meta).toEqual({ exchangeId: "x-1" });
      expect(seen).toEqual([1, 2]);
    });
  });

  it("writes a human-readable Markdown transcript on finalize()", async () => {
    await withTempDir(async (dir) => {
      const log = ConversationLog.forRun(dir);
      await log.status("plan", "starting");
      await log.prompt({ stage: "plan", actor: "claude", content: "hello" });
      await log.response({ stage: "plan", actor: "claude", content: "world", exitCode: 0 });
      await log.finalize();

      const md = await readFile(path.join(dir, "conversation.md"), "utf8");
      expect(md).toContain("Conversation transcript");
      expect(md).toContain("plan/orchestrator — status");
      expect(md).toContain("plan/claude — prompt");
      expect(md).toContain("plan/claude — response");
    });
  });

  it("groups events by round in the rendered transcript", () => {
    const md = renderTranscript([
      {
        seq: 0,
        ts: "2026-01-01T00:00:00Z",
        round: null,
        stage: "prepare",
        actor: "user",
        kind: "prompt",
        content: "do x",
      },
      {
        seq: 1,
        ts: "2026-01-01T00:00:01Z",
        round: 1,
        stage: "plan",
        actor: "claude",
        kind: "response",
        content: "{}",
        exitCode: 0,
      },
      {
        seq: 2,
        ts: "2026-01-01T00:00:02Z",
        round: 2,
        stage: "review",
        actor: "claude",
        kind: "response",
        content: "{}",
      },
    ]);
    expect(md).toContain("## Setup");
    expect(md).toContain("## Round 1");
    expect(md).toContain("## Round 2");
  });
});

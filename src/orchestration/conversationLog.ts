import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "../utils/redact.js";
import type { EventBus } from "./eventBus.js";

/**
 * Append-only conversation log for a single run.
 *
 * Captures every prompt the orchestrator sends to a worker, every response,
 * every verifier command and its output, and every status event. Stored as:
 *
 *   runs/<id>/conversation.jsonl   (one event per line, machine-readable)
 *   runs/<id>/conversation.md      (human-readable transcript, written on close())
 *
 * All content is redacted for credentials before it touches disk.
 */
export type ConversationKind =
  | "status"
  | "prompt"
  | "response"
  | "verifier_command"
  | "verifier_output"
  | "error";

export type ConversationStage =
  | "prepare"
  | "plan"
  | "implement"
  | "verify"
  | "review"
  | "repair"
  | "report";

export interface ConversationEvent {
  /** Monotonic per-run sequence number (bus-issued when a bus is attached). */
  seq: number;
  ts: string;
  round: number | null;
  stage: ConversationStage;
  /** worker name ("claude" | "codex" | "cursor" | "verifier" | "orchestrator") */
  actor: string;
  kind: ConversationKind;
  content: string;
  durationMs?: number;
  exitCode?: number;
  /** Optional structured payload (parsed JSON, exchangeId, etc.). */
  meta?: Record<string, unknown>;
}

/** Payload shape this log publishes onto the event bus. */
export interface ConversationBusPayload {
  type: "conversation";
  event: ConversationEvent;
}

export class ConversationLog {
  private events: ConversationEvent[] = [];
  private localSeq = 0;
  /** Serializes jsonl appends so concurrent callers can't interleave lines. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly jsonlPath: string,
    private readonly mdPath: string,
    private readonly bus?: EventBus,
    private readonly topic?: string,
  ) {}

  static forRun(runDir: string, bus?: EventBus, topic?: string): ConversationLog {
    return new ConversationLog(
      path.join(runDir, "conversation.jsonl"),
      path.join(runDir, "conversation.md"),
      bus,
      topic,
    );
  }

  async append(event: Omit<ConversationEvent, "ts" | "seq"> & { ts?: string }): Promise<void> {
    const full: ConversationEvent = {
      ...event,
      seq: this.localSeq++,
      ts: event.ts ?? new Date().toISOString(),
      content: redact(event.content ?? ""),
    };
    // When a bus is attached, the bus owns sequencing: the seq it assigns is
    // the one persisted, so the jsonl on disk and any live subscriber (REPL,
    // future SSE stream) agree on event order.
    if (this.bus && this.topic) {
      const busEvent = this.bus.publish<ConversationBusPayload>(this.topic, {
        type: "conversation",
        event: full,
      });
      full.seq = busEvent.seq;
      full.ts = busEvent.ts;
    }
    this.events.push(full);
    this.writeChain = this.writeChain.then(() =>
      appendFile(this.jsonlPath, JSON.stringify(full) + "\n", "utf8"),
    );
    await this.writeChain;
  }

  async status(stage: ConversationStage, content: string, round: number | null = null): Promise<void> {
    await this.append({ round, stage, actor: "orchestrator", kind: "status", content });
  }

  async prompt(args: {
    stage: ConversationStage;
    actor: string;
    content: string;
    round?: number | null;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.append({
      stage: args.stage,
      actor: args.actor,
      kind: "prompt",
      content: args.content,
      round: args.round ?? null,
      meta: args.meta,
    });
  }

  async response(args: {
    stage: ConversationStage;
    actor: string;
    content: string;
    durationMs?: number;
    exitCode?: number;
    round?: number | null;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.append({
      stage: args.stage,
      actor: args.actor,
      kind: "response",
      content: args.content,
      durationMs: args.durationMs,
      exitCode: args.exitCode,
      round: args.round ?? null,
      meta: args.meta,
    });
  }

  async verifierCommand(round: number, command: string): Promise<void> {
    await this.append({
      round,
      stage: "verify",
      actor: "verifier",
      kind: "verifier_command",
      content: command,
    });
  }

  async verifierOutput(args: {
    round: number;
    command: string;
    exitCode: number;
    durationMs: number;
    tail: string;
  }): Promise<void> {
    await this.append({
      round: args.round,
      stage: "verify",
      actor: "verifier",
      kind: "verifier_output",
      content: args.tail,
      exitCode: args.exitCode,
      durationMs: args.durationMs,
      meta: { command: args.command },
    });
  }

  async error(stage: ConversationStage, actor: string, content: string, round: number | null = null): Promise<void> {
    await this.append({ stage, actor, kind: "error", content, round });
  }

  /** Snapshot of all events captured so far. */
  snapshot(): ConversationEvent[] {
    return [...this.events];
  }

  /** Render and persist the human-readable Markdown transcript. */
  async finalize(): Promise<void> {
    const md = renderTranscript(this.events);
    await writeFile(this.mdPath, md, "utf8");
  }
}

export function renderTranscript(events: ConversationEvent[]): string {
  const lines: string[] = ["# Conversation transcript", ""];
  let lastRound: number | null | undefined = undefined;
  for (const e of events) {
    if (e.round !== lastRound) {
      lastRound = e.round;
      lines.push("");
      lines.push(e.round === null ? "## Setup" : `## Round ${e.round}`);
      lines.push("");
    }
    const head =
      `**[${e.ts}] ${e.stage}/${e.actor} — ${e.kind}` +
      (e.exitCode !== undefined ? `, exit=${e.exitCode}` : "") +
      (e.durationMs !== undefined ? `, ${e.durationMs}ms` : "") +
      "**";
    lines.push(head);
    if (e.kind === "status" || e.kind === "verifier_command" || e.kind === "error") {
      lines.push("");
      lines.push("> " + e.content.replace(/\n/g, "\n> "));
      lines.push("");
    } else {
      lines.push("");
      lines.push("```");
      lines.push(truncate(e.content, 4000));
      lines.push("```");
      lines.push("");
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} chars]…`;
}

import { extractJson } from "../utils/jsonExtract.js";
import type { Worker, WorkerInput, WorkerResult } from "./Worker.js";

export type MockResponder = (input: WorkerInput) => Promise<WorkerResult> | WorkerResult;

export interface MockWorkerOptions {
  name: string;
  enabled?: boolean;
  /** A queue of responders consumed in order; the last one is reused if the queue runs out. */
  responders?: MockResponder[];
  /** Static stdout used when no responders are provided. */
  stdout?: string;
  /** Static exit code used when no responders are provided. */
  exitCode?: number;
  /** Simulated work duration in ms. */
  durationMs?: number;
  /** When true, simulates a timeout by returning timedOut=true. */
  simulateTimeout?: boolean;
  /**
   * Simulate an envelope-compliant worker: when the prompt carries an
   * `exchange_id: …` line and the response parses as a JSON object, the id is
   * echoed into the parsed payload (unless already present). Default true so
   * test fixtures don't need to hand-craft echoes; set false to exercise the
   * protocol-error path.
   */
  autoEcho?: boolean;
}

const EXCHANGE_ID_LINE = /^exchange_id:\s*(\S+)\s*$/m;

/**
 * Deterministic worker for tests and for "disabled" deterministic fallbacks
 * inside the workflow. Never spawns subprocesses.
 */
export class MockWorker implements Worker {
  readonly name: string;
  readonly enabled: boolean;
  private queue: MockResponder[];
  private staticResult: WorkerResult;
  private autoEcho: boolean;

  constructor(opts: MockWorkerOptions) {
    this.name = opts.name;
    this.enabled = opts.enabled ?? true;
    this.autoEcho = opts.autoEcho ?? true;
    this.queue = opts.responders ? [...opts.responders] : [];
    const stdout = opts.stdout ?? "";
    this.staticResult = {
      exitCode: opts.exitCode ?? 0,
      stdout,
      stderr: "",
      durationMs: opts.durationMs ?? 1,
      outputFiles: [],
      parsedJson: extractJson(stdout) ?? undefined,
      timedOut: opts.simulateTimeout ?? false,
    };
  }

  async run(input: WorkerInput): Promise<WorkerResult> {
    let result: WorkerResult;
    if (this.queue.length === 0) {
      result = { ...this.staticResult };
    } else {
      const responder = this.queue.length === 1 ? this.queue[0]! : this.queue.shift()!;
      result = await responder(input);
      if (result.parsedJson === undefined && result.stdout) {
        const parsed = extractJson(result.stdout);
        if (parsed !== null) result.parsedJson = parsed;
      }
    }
    if (this.autoEcho) {
      const m = EXCHANGE_ID_LINE.exec(input.prompt);
      if (
        m?.[1] &&
        result.parsedJson &&
        typeof result.parsedJson === "object" &&
        !Array.isArray(result.parsedJson) &&
        (result.parsedJson as Record<string, unknown>)["exchange_id"] === undefined
      ) {
        result.parsedJson = { ...(result.parsedJson as Record<string, unknown>), exchange_id: m[1] };
      }
    }
    return result;
  }
}

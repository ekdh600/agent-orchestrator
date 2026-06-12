/**
 * In-process pub/sub event bus.
 *
 * The orchestrator's internal spine: workflow stages, worker calls, the
 * verifier and the project loop PUBLISH; the conversation log writer, the
 * timeline writer, progress renderers (CLI / REPL) and — later — an HTTP SSE
 * stream SUBSCRIBE. Workers themselves never touch the bus: worker
 * communication stays strict request/response (see envelope.ts).
 *
 * Guarantees:
 *   - per-topic monotonic `seq`, assigned at publish time. Subscribers and
 *     durable logs (conversation.jsonl / timeline.jsonl) record this seq, so
 *     event order stays deterministic even when parallel tasks interleave
 *     events with colliding millisecond timestamps.
 *   - subscriber isolation: a throwing subscriber never breaks the publisher
 *     or other subscribers. Async subscriber rejections are swallowed the
 *     same way; call flush() to await all in-flight async handlers.
 *
 * Topics are plain strings, by convention `run:<runId>` / `project:<projectId>`.
 * Subscribe patterns: exact topic, `"*"` (everything) or a `"prefix:*"` glob.
 */

export interface BusEvent<T = unknown> {
  /** Monotonic per-topic sequence number, assigned by the bus. */
  seq: number;
  ts: string;
  topic: string;
  payload: T;
}

export type BusHandler = (event: BusEvent) => void | Promise<void>;

export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) return topic.startsWith(pattern.slice(0, -1));
  return pattern === topic;
}

export class EventBus {
  private seqByTopic = new Map<string, number>();
  private subscribers: { pattern: string; handler: BusHandler }[] = [];
  private inFlight: Promise<unknown>[] = [];

  /**
   * Publish an event. Assigns the next seq for the topic, dispatches to every
   * matching subscriber (errors isolated), and returns the stamped event so
   * the publisher can record the seq (e.g. into conversation.jsonl).
   */
  publish<T>(topic: string, payload: T): BusEvent<T> {
    const seq = (this.seqByTopic.get(topic) ?? -1) + 1;
    this.seqByTopic.set(topic, seq);
    const event: BusEvent<T> = { seq, ts: new Date().toISOString(), topic, payload };
    for (const sub of this.subscribers) {
      if (!topicMatches(sub.pattern, topic)) continue;
      try {
        const result = sub.handler(event as BusEvent);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          this.inFlight.push((result as Promise<unknown>).catch(() => undefined));
        }
      } catch {
        // subscriber isolation — never let an observer crash the publisher
      }
    }
    return event;
  }

  /** Subscribe to a topic pattern. Returns an unsubscribe function. */
  subscribe(pattern: string, handler: BusHandler): () => void {
    const entry = { pattern, handler };
    this.subscribers.push(entry);
    return () => {
      const i = this.subscribers.indexOf(entry);
      if (i !== -1) this.subscribers.splice(i, 1);
    };
  }

  /** Await every async subscriber that has been dispatched so far. */
  async flush(): Promise<void> {
    while (this.inFlight.length > 0) {
      const batch = this.inFlight;
      this.inFlight = [];
      await Promise.all(batch);
    }
  }

  /** Last assigned seq for a topic, or -1 if nothing was published yet. */
  lastSeq(topic: string): number {
    return this.seqByTopic.get(topic) ?? -1;
  }
}

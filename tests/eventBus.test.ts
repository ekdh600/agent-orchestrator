import { describe, it, expect } from "vitest";
import { EventBus, topicMatches } from "../src/orchestration/eventBus.js";

describe("topicMatches", () => {
  it("matches exact topics, prefix globs and the global wildcard", () => {
    expect(topicMatches("run:abc", "run:abc")).toBe(true);
    expect(topicMatches("run:abc", "run:xyz")).toBe(false);
    expect(topicMatches("run:*", "run:abc")).toBe(true);
    expect(topicMatches("run:*", "project:abc")).toBe(false);
    expect(topicMatches("*", "anything")).toBe(true);
  });
});

describe("EventBus", () => {
  it("assigns monotonic per-topic seq starting at 0", () => {
    const bus = new EventBus();
    expect(bus.publish("run:a", { n: 1 }).seq).toBe(0);
    expect(bus.publish("run:a", { n: 2 }).seq).toBe(1);
    // independent counter per topic
    expect(bus.publish("run:b", { n: 1 }).seq).toBe(0);
    expect(bus.publish("run:a", { n: 3 }).seq).toBe(2);
    expect(bus.lastSeq("run:a")).toBe(2);
    expect(bus.lastSeq("run:never")).toBe(-1);
  });

  it("keeps seq monotonic under interleaved publishes from concurrent sources", async () => {
    const bus = new EventBus();
    const publishMany = async (label: string) => {
      for (let i = 0; i < 50; i++) {
        bus.publish("run:x", { label, i });
        // yield so publishers interleave
        await Promise.resolve();
      }
    };
    const seen: number[] = [];
    bus.subscribe("run:x", (e) => {
      seen.push(e.seq);
    });
    await Promise.all([publishMany("a"), publishMany("b"), publishMany("c")]);
    expect(seen.length).toBe(150);
    for (let i = 0; i < seen.length; i++) expect(seen[i]).toBe(i);
  });

  it("dispatches only to matching subscribers and supports unsubscribe", () => {
    const bus = new EventBus();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = bus.subscribe("run:a", (e) => a.push(e.payload));
    bus.subscribe("run:*", (e) => b.push(e.payload));

    bus.publish("run:a", 1);
    bus.publish("run:b", 2);
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);

    offA();
    bus.publish("run:a", 3);
    expect(a).toEqual([1]); // unsubscribed
    expect(b).toEqual([1, 2, 3]);
  });

  it("isolates subscriber errors (sync throw and async rejection)", async () => {
    const bus = new EventBus();
    const received: number[] = [];
    bus.subscribe("t", () => {
      throw new Error("sync boom");
    });
    bus.subscribe("t", async () => {
      throw new Error("async boom");
    });
    bus.subscribe("t", (e) => {
      received.push(e.seq);
    });

    expect(() => bus.publish("t", {})).not.toThrow();
    bus.publish("t", {});
    await expect(bus.flush()).resolves.toBeUndefined();
    expect(received).toEqual([0, 1]);
  });

  it("flush awaits async subscribers dispatched so far", async () => {
    const bus = new EventBus();
    let done = false;
    bus.subscribe("t", async () => {
      await new Promise((r) => setTimeout(r, 20));
      done = true;
    });
    bus.publish("t", {});
    expect(done).toBe(false);
    await bus.flush();
    expect(done).toBe(true);
  });
});

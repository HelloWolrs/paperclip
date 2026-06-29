import { describe, expect, it, vi } from "vitest";
import {
  startAcpPollWorker,
  type AcpPollAgentSnapshot,
  type AcpPollEnvelope,
  type AcpPollLogger,
  type AcpPollWorkerDeps,
} from "../services/acp-poll-worker.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeLogger extends AcpPollLogger {
  records: Array<{ level: "info" | "warn" | "error"; obj: Record<string, unknown>; msg?: string }>;
}

function makeLogger(): FakeLogger {
  const records: FakeLogger["records"] = [];
  return {
    records,
    info: (obj, msg) => records.push({ level: "info", obj, msg }),
    warn: (obj, msg) => records.push({ level: "warn", obj, msg }),
    error: (obj, msg) => records.push({ level: "error", obj, msg }),
  };
}

class ManualClock {
  private nowValue = 0;
  now = () => this.nowValue;
  advance(ms: number): void {
    this.nowValue += ms;
  }
}

// Deterministic sleep that wakes immediately if aborted, otherwise resolves
// without actually waiting. Tests don't need real time to elapse — the
// worker tracks state purely through awaits.
function makeInstantSleep() {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number, signal: AbortSignal): Promise<void> => {
      calls.push(ms);
      if (signal.aborted) return Promise.resolve();
      return Promise.resolve();
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function makeAgent(overrides: Partial<AcpPollAgentSnapshot> = {}): AcpPollAgentSnapshot {
  return {
    companyId: "company-1",
    agentId: "agent-1",
    slug: "basys-analytics-agent",
    token: "tok-abc",
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<AcpPollEnvelope> = {}): AcpPollEnvelope {
  return {
    id: "env-1",
    agentSlug: "basys-analytics-agent",
    tenantId: "tenant-1",
    idempotencyKey: "idem-1",
    payload: { title: "ACP dispatch: do thing", assigneeAgentId: "agent-1" },
    ...overrides,
  };
}

// Sequenced fetch: returns one response per call from a queue. If the
// queue runs dry, aborts the worker and returns a never-resolving
// promise — that's how the test signals "ok, you've polled enough times".
function makeSequencedFetch(
  responses: Array<Response | Error>,
  onExhausted?: () => void,
): { fetch: typeof globalThis.fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    if (i >= responses.length) {
      onExhausted?.();
      // Block forever so the worker's await never returns; outer test
      // aborts the worker which propagates AbortError.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by test")));
      });
    }
    const next = responses[i++];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch: fakeFetch, calls };
}

function makeDeps(overrides: Partial<AcpPollWorkerDeps> & {
  agentsSnapshot: AcpPollWorkerDeps["agentsSnapshot"];
  createIssueFromDispatch?: AcpPollWorkerDeps["createIssueFromDispatch"];
}): AcpPollWorkerDeps {
  const clock = new ManualClock();
  const sleep = makeInstantSleep().sleep;
  return {
    baseUrl: "https://marketplace.example",
    pollWaitSeconds: 30,
    fetch: globalThis.fetch,
    nowMs: clock.now,
    sleep,
    logger: makeLogger(),
    createIssueFromDispatch: vi.fn().mockResolvedValue({ id: "issue-1", identifier: "TEST-1" }),
    reconcileIntervalMs: 999_999, // disable periodic reconcile in tests
    ...overrides,
  };
}

// Helper: wait until a predicate is true or the test times out.
async function waitFor(predicate: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  const intervalMs = opts.intervalMs ?? 5;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acp-poll-worker", () => {
  it("starts a loop per agent returned by snapshot", async () => {
    const agentA = makeAgent({ agentId: "a", slug: "agent-a", token: "tok-a" });
    const agentB = makeAgent({ agentId: "b", slug: "agent-b", token: "tok-b" });
    const { fetch } = makeSequencedFetch([]);
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([agentA, agentB]),
        fetch,
      }),
    );
    await waitFor(() => handle.activeLoopCount() === 2);
    await handle.stop(50);
  });

  it("on 200 creates issue, posts ack, and re-polls without backoff", async () => {
    const envelope = makeEnvelope();
    const { fetch, calls } = makeSequencedFetch([
      jsonResponse(200, envelope),
      emptyResponse(200), // ack response
      emptyResponse(204), // next poll: empty
    ]);
    const createIssue = vi.fn().mockResolvedValue({ id: "issue-1", identifier: "TEST-1" });
    const sleepHarness = makeInstantSleep();
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent()]),
        createIssueFromDispatch: createIssue,
        fetch,
        sleep: sleepHarness.sleep,
      }),
    );
    await waitFor(() => calls.length >= 3);
    await handle.stop(50);

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0]?.[1]).toEqual(envelope);

    // Three URL hits: poll, ack, poll
    expect(calls[0]?.url).toContain("/api/acp/dispatch/agent-poll?wait=30s");
    expect(calls[1]?.url).toContain("/api/acp/dispatch/agent-poll/env-1/ack");
    expect(calls[2]?.url).toContain("/api/acp/dispatch/agent-poll?wait=30s");

    // No backoff sleep recorded between poll-200 and next poll
    expect(sleepHarness.calls).toEqual([]);
  });

  it("on 204 re-polls without backoff and without creating an issue", async () => {
    const { fetch, calls } = makeSequencedFetch([
      emptyResponse(204),
      emptyResponse(204),
    ]);
    const createIssue = vi.fn();
    const sleepHarness = makeInstantSleep();
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent()]),
        createIssueFromDispatch: createIssue,
        fetch,
        sleep: sleepHarness.sleep,
      }),
    );
    await waitFor(() => calls.length >= 2);
    await handle.stop(50);

    expect(createIssue).not.toHaveBeenCalled();
    expect(sleepHarness.calls).toEqual([]);
  });

  it("on 401 logs warn and sleeps the unauthorized cooldown", async () => {
    const { fetch, calls } = makeSequencedFetch([
      emptyResponse(401),
    ]);
    const sleepHarness = makeInstantSleep();
    const logger = makeLogger();
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent()]),
        fetch,
        sleep: sleepHarness.sleep,
        logger,
        unauthorizedCooldownMs: 60_000,
      }),
    );
    await waitFor(() => sleepHarness.calls.includes(60_000));
    await handle.stop(50);

    expect(calls).toHaveLength(2); // initial poll + post-cooldown poll attempt
    const warn = logger.records.find((r) => r.level === "warn" && r.obj.result === 401);
    expect(warn).toBeDefined();
  });

  it("on 5xx applies exponential backoff capped at backoffMaxMs", async () => {
    const { fetch } = makeSequencedFetch([
      emptyResponse(500),
      emptyResponse(503),
      emptyResponse(502),
      emptyResponse(500),
      emptyResponse(500),
    ]);
    const sleepHarness = makeInstantSleep();
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent()]),
        fetch,
        sleep: sleepHarness.sleep,
        backoffStartMs: 1_000,
        backoffMaxMs: 8_000,
      }),
    );
    await waitFor(() => sleepHarness.calls.length >= 4);
    await handle.stop(50);

    // 1000, 2000, 4000, 8000 (capped)
    expect(sleepHarness.calls.slice(0, 4)).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("idempotency LRU dedups same envelope and skips createIssue on the duplicate", async () => {
    const envelope = makeEnvelope({ id: "env-A" });
    const dupEnvelope = makeEnvelope({ id: "env-B", idempotencyKey: "idem-1" }); // same key
    const { fetch } = makeSequencedFetch([
      jsonResponse(200, envelope),
      emptyResponse(200), // ack
      jsonResponse(200, dupEnvelope),
      emptyResponse(200), // ack
    ]);
    const createIssue = vi.fn().mockResolvedValue({ id: "x", identifier: "X-1" });
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent()]),
        createIssueFromDispatch: createIssue,
        fetch,
      }),
    );
    await waitFor(() => createIssue.mock.calls.length >= 1, { timeoutMs: 1_000 });
    // Give worker time to also process the duplicate (it shouldn't call createIssue again).
    await new Promise((r) => setTimeout(r, 30));
    await handle.stop(50);

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0]?.[1].id).toBe("env-A");
  });

  it("ack failure does NOT block re-polling (server already marked delivered)", async () => {
    const envelope = makeEnvelope();
    const { fetch } = makeSequencedFetch([
      jsonResponse(200, envelope),
      new Error("network broke on ack"), // ack throws
      emptyResponse(204), // next poll still happens
    ]);
    const createIssue = vi.fn().mockResolvedValue({ id: "x", identifier: "X-1" });
    const logger = makeLogger();
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent()]),
        createIssueFromDispatch: createIssue,
        fetch,
        logger,
      }),
    );
    await waitFor(
      () => logger.records.some((r) => r.msg?.includes("ack failed")),
      { timeoutMs: 1_000 },
    );
    await handle.stop(50);
    expect(createIssue).toHaveBeenCalledTimes(1);
  });

  it("token is never logged in any log record", async () => {
    const secret = "super-secret-token-value-do-not-leak";
    const envelope = makeEnvelope();
    const { fetch } = makeSequencedFetch([
      jsonResponse(200, envelope),
      emptyResponse(200),
      emptyResponse(401), // also a 401 path so we hit the warn branch
    ]);
    const logger = makeLogger();
    const sleepHarness = makeInstantSleep();
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent({ token: secret })]),
        fetch,
        logger,
        sleep: sleepHarness.sleep,
      }),
    );
    await waitFor(() => logger.records.length >= 3, { timeoutMs: 1_000 });
    await handle.stop(50);

    for (const record of logger.records) {
      expect(JSON.stringify(record)).not.toContain(secret);
    }
  });

  it("reconcile stops loops for agents that disappear", async () => {
    const agent = makeAgent();
    const snapshotFn = vi.fn().mockResolvedValueOnce([agent]).mockResolvedValueOnce([]);
    const { fetch } = makeSequencedFetch([
      emptyResponse(204),
      emptyResponse(204),
    ]);
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: snapshotFn,
        fetch,
      }),
    );
    await waitFor(() => handle.activeLoopCount() === 1);
    await handle.reconcileNow();
    await waitFor(() => handle.activeLoopCount() === 0);
    await handle.stop(50);
  });

  it("reconcile restarts a loop when its token rotates", async () => {
    const agent1 = makeAgent({ token: "tok-v1" });
    const agent2 = makeAgent({ token: "tok-v2" });
    const snapshotFn = vi.fn().mockResolvedValueOnce([agent1]).mockResolvedValueOnce([agent2]);
    const { fetch, calls } = makeSequencedFetch([
      emptyResponse(204),
      emptyResponse(204),
      emptyResponse(204),
    ]);
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: snapshotFn,
        fetch,
      }),
    );
    await waitFor(() => calls.length >= 1);
    await handle.reconcileNow();
    await waitFor(() => handle.activeLoopCount() === 1 && calls.length >= 2);
    await handle.stop(50);

    const tokensSeen = new Set(calls.map((c) => (c.init?.headers as Record<string, string>)?.Authorization));
    expect(tokensSeen.has("Bearer tok-v1")).toBe(true);
    expect(tokensSeen.has("Bearer tok-v2")).toBe(true);
  });

  it("bumpLastSuccessfulPoll fires on 200 and 204 but not on 5xx", async () => {
    const { fetch } = makeSequencedFetch([
      jsonResponse(200, makeEnvelope()),
      emptyResponse(200),
      emptyResponse(204),
      emptyResponse(500),
    ]);
    const sleepHarness = makeInstantSleep();
    const bumpFn = vi.fn().mockResolvedValue(undefined);
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent()]),
        fetch,
        sleep: sleepHarness.sleep,
        bumpLastSuccessfulPoll: bumpFn,
      }),
    );
    await waitFor(() => bumpFn.mock.calls.length >= 2);
    await handle.stop(50);

    expect(bumpFn).toHaveBeenCalledTimes(2);
  });

  it("stop drains and stops all loops within drainTimeoutMs", async () => {
    const { fetch } = makeSequencedFetch([emptyResponse(204), emptyResponse(204)]);
    const handle = startAcpPollWorker(
      makeDeps({
        agentsSnapshot: vi.fn().mockResolvedValue([makeAgent(), makeAgent({ agentId: "b", slug: "agent-b" })]),
        fetch,
      }),
    );
    await waitFor(() => handle.activeLoopCount() === 2);
    const start = Date.now();
    await handle.stop(500);
    expect(Date.now() - start).toBeLessThan(700);
  });
});

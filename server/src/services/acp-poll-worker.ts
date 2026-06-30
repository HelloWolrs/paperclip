// ACP outbound long-poll worker.
//
// One async loop per (companyId, agentId, slug, token). Each loop dials
// the marketplace's `GET /api/acp/dispatch/agent-poll?wait=30s` endpoint,
// creates a Paperclip issue from the returned envelope (deduped against
// a per-agent LRU of recent idempotencyKeys), POSTs an ack, and re-polls.
//
// All side effects (HTTP, time, logging, DB) are injected so the loop is
// fully unit-testable. See `__tests__/acp-poll-worker.test.ts`.
//
// Spec: BASA-30556. Parent: BASA-30552.

export interface AcpPollAgentSnapshot {
  companyId: string;
  agentId: string;
  slug: string;
  token: string;
}

export interface AcpPollEnvelope {
  id: string;
  agentSlug: string;
  tenantId: string;
  idempotencyKey: string;
  // payload is the dispatch body marketplace today POSTs to
  // /api/companies/{cid}/issues — title, description, priority, etc.
  payload: Record<string, unknown>;
}

export interface AcpPollLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface AcpPollWorkerDeps {
  baseUrl: string;
  // Wait seconds passed to the marketplace long-poll endpoint. Default 30.
  pollWaitSeconds?: number;
  // Per-agent LRU cap. Default 100.
  idempotencyLruSize?: number;
  // Per-agent LRU TTL in ms. Default 5 minutes.
  idempotencyTtlMs?: number;
  // Backoff config (ms). 5xx ladder: start → max.
  backoffStartMs?: number;
  backoffMaxMs?: number;
  // Network retry: this many instant retries, then sleep this long.
  networkInstantRetries?: number;
  networkBackoffMs?: number;
  // 401/403 cooldown before re-trying that agent. Default 60s.
  unauthorizedCooldownMs?: number;
  // Periodic reconcile interval for agent set changes. Default 60s.
  reconcileIntervalMs?: number;

  fetch: typeof globalThis.fetch;
  nowMs: () => number;
  // Sleep that wakes early on abort.
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  logger: AcpPollLogger;

  // Returns the current set of agents with ACP tokens. Called once at
  // start, then every reconcileIntervalMs. Implementations should
  // dedupe-by-(companyId,agentId,slug) themselves.
  agentsSnapshot: () => Promise<AcpPollAgentSnapshot[]>;

  // Creates a Paperclip issue from the dispatch payload. Must throw on
  // failure so the worker re-polls (the row is already `delivered` on the
  // marketplace side, but at-least-once + idempotencyKey will dedup).
  createIssueFromDispatch: (
    snapshot: AcpPollAgentSnapshot,
    envelope: AcpPollEnvelope,
  ) => Promise<{ id: string; identifier: string } | null>;

  // Bumps the agent's lastSuccessfulAcpPollAt metadata. Fire-and-forget;
  // failures are logged but do not break the loop.
  bumpLastSuccessfulPoll?: (agentId: string, at: Date) => Promise<void>;
}

interface IdempotencyEntry {
  insertedAt: number;
}

class IdempotencyLru {
  private readonly entries = new Map<string, IdempotencyEntry>();
  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  has(key: string, nowMs: number): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (nowMs - entry.insertedAt > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  set(key: string, nowMs: number): void {
    // Touch-on-set: re-insert to refresh insertion order (Map preserves
    // insertion order, so deleting + setting moves to the end).
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { insertedAt: nowMs });
    while (this.entries.size > this.maxSize) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  // Test hook
  size(): number {
    return this.entries.size;
  }
}

interface LoopHandle {
  snapshot: AcpPollAgentSnapshot;
  abortController: AbortController;
  done: Promise<void>;
}

export interface AcpPollWorkerHandle {
  // Returns once all per-agent loops have settled (or the 5s drain
  // window expires).
  stop: (drainTimeoutMs?: number) => Promise<void>;
  // Test hook: returns the number of active loops.
  activeLoopCount: () => number;
  // Test hook: trigger an immediate reconcile.
  reconcileNow: () => Promise<void>;
}

// Map for deduping snapshots by composite key. agentId + slug because in
// theory one agent could carry multiple slug tokens, though v1 expects 1:1.
function snapshotKey(s: AcpPollAgentSnapshot): string {
  return `${s.agentId}::${s.slug}`;
}

export function startAcpPollWorker(deps: AcpPollWorkerDeps): AcpPollWorkerHandle {
  const pollWaitSeconds = deps.pollWaitSeconds ?? 30;
  const lruSize = deps.idempotencyLruSize ?? 100;
  const lruTtlMs = deps.idempotencyTtlMs ?? 5 * 60 * 1000;
  const backoffStartMs = deps.backoffStartMs ?? 1_000;
  const backoffMaxMs = deps.backoffMaxMs ?? 30_000;
  const networkInstantRetries = deps.networkInstantRetries ?? 3;
  const networkBackoffMs = deps.networkBackoffMs ?? 5_000;
  const unauthorizedCooldownMs = deps.unauthorizedCooldownMs ?? 60_000;
  const reconcileIntervalMs = deps.reconcileIntervalMs ?? 60_000;
  // Marketplace holds the response for pollWaitSeconds; give it a touch
  // of slack on the client side before timing out.
  const requestTimeoutMs = (pollWaitSeconds + 5) * 1_000;

  const loops = new Map<string, LoopHandle>();
  const stopController = new AbortController();

  async function runAgentLoop(snapshot: AcpPollAgentSnapshot, signal: AbortSignal): Promise<void> {
    const lru = new IdempotencyLru(lruSize, lruTtlMs);
    let backoffMs = 0;
    // Hoisted above the while so the count persists across iterations.
    // If this declaration sits inside the loop the network catch keeps
    // re-entering the "instant retry" branch forever and the sleep is
    // never reached — a tight-loop DoS-against-self on persistent
    // network failure (BASA-30565 Marek review).
    let networkAttempts = 0;

    while (!signal.aborted) {
      const start = deps.nowMs();
      let pollUrl = `${deps.baseUrl}/api/acp/dispatch/agent-poll?wait=${pollWaitSeconds}s`;

      try {
        const res = await fetchWithTimeout(
          deps.fetch,
          pollUrl,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${snapshot.token}` },
          },
          requestTimeoutMs,
          signal,
        );
        // Got an HTTP response — reset the network-attempt counter so the
        // next network failure starts from a clean instant-retry budget.
        networkAttempts = 0;

        if (res.status === 200) {
          const envelope = (await res.json()) as AcpPollEnvelope;
          const key = envelope.idempotencyKey;
          if (key && lru.has(key, deps.nowMs())) {
            deps.logger.info({
              tag: "acp-poll",
              agent: snapshot.slug,
              waited: deps.nowMs() - start,
              result: 200,
              dedup: true,
            });
          } else {
            if (key) lru.set(key, deps.nowMs());
            try {
              await deps.createIssueFromDispatch(snapshot, envelope);
            } catch (err) {
              deps.logger.error({
                tag: "acp-poll",
                agent: snapshot.slug,
                envelopeId: envelope.id,
                err: errorSummary(err),
              }, "createIssueFromDispatch failed");
              // Fall through to ack regardless — the marketplace row is
              // already `delivered`. Skipping the ack just means the
              // optional confirmation step is missed; idempotencyKey
              // handles dedup on retry.
            }
            deps.logger.info({
              tag: "acp-poll",
              agent: snapshot.slug,
              waited: deps.nowMs() - start,
              result: 200,
              envelopeId: envelope.id,
            });
          }
          await ackQuietly(deps, snapshot, envelope.id, signal);
          if (deps.bumpLastSuccessfulPoll) {
            void deps.bumpLastSuccessfulPoll(snapshot.agentId, new Date(deps.nowMs())).catch((err) => {
              deps.logger.warn({
                tag: "acp-poll",
                agent: snapshot.slug,
                err: errorSummary(err),
              }, "bumpLastSuccessfulPoll failed");
            });
          }
          backoffMs = 0;
          continue;
        }

        if (res.status === 204) {
          deps.logger.info({
            tag: "acp-poll",
            agent: snapshot.slug,
            waited: deps.nowMs() - start,
            result: 204,
          });
          if (deps.bumpLastSuccessfulPoll) {
            void deps.bumpLastSuccessfulPoll(snapshot.agentId, new Date(deps.nowMs())).catch(() => {});
          }
          backoffMs = 0;
          continue;
        }

        if (res.status === 401 || res.status === 403) {
          deps.logger.warn({
            tag: "acp-poll",
            agent: snapshot.slug,
            result: res.status,
          }, "unauthorized; will retry after cooldown");
          await deps.sleep(unauthorizedCooldownMs, signal);
          continue;
        }

        if (res.status >= 500 && res.status < 600) {
          backoffMs = backoffMs === 0 ? backoffStartMs : Math.min(backoffMs * 2, backoffMaxMs);
          deps.logger.warn({
            tag: "acp-poll",
            agent: snapshot.slug,
            result: res.status,
            backoffMs,
          }, "5xx from marketplace; backing off");
          await deps.sleep(backoffMs, signal);
          continue;
        }

        // Unexpected status (e.g. 400). Treat as a retryable error with
        // the same backoff ladder as 5xx so a misconfiguration doesn't
        // tight-loop.
        backoffMs = backoffMs === 0 ? backoffStartMs : Math.min(backoffMs * 2, backoffMaxMs);
        deps.logger.warn({
          tag: "acp-poll",
          agent: snapshot.slug,
          result: res.status,
          backoffMs,
        }, "unexpected status; backing off");
        await deps.sleep(backoffMs, signal);
      } catch (err) {
        if (signal.aborted) break;
        networkAttempts += 1;
        if (networkAttempts <= networkInstantRetries) {
          deps.logger.warn({
            tag: "acp-poll",
            agent: snapshot.slug,
            attempt: networkAttempts,
            err: errorSummary(err),
          }, "network error; instant retry");
          continue;
        }
        deps.logger.warn({
          tag: "acp-poll",
          agent: snapshot.slug,
          err: errorSummary(err),
          backoffMs: networkBackoffMs,
        }, "network error; backing off");
        await deps.sleep(networkBackoffMs, signal);
        networkAttempts = 0;
      }
    }
  }

  async function reconcile(): Promise<void> {
    if (stopController.signal.aborted) return;
    let snapshots: AcpPollAgentSnapshot[];
    try {
      snapshots = await deps.agentsSnapshot();
    } catch (err) {
      deps.logger.error({
        tag: "acp-poll",
        err: errorSummary(err),
      }, "agentsSnapshot failed; keeping existing loops");
      return;
    }

    const desiredByKey = new Map<string, AcpPollAgentSnapshot>();
    for (const s of snapshots) {
      desiredByKey.set(snapshotKey(s), s);
    }

    // Stop loops whose agent disappeared OR whose token rotated.
    for (const [key, handle] of loops) {
      const desired = desiredByKey.get(key);
      if (!desired || desired.token !== handle.snapshot.token) {
        handle.abortController.abort();
        loops.delete(key);
        deps.logger.info({
          tag: "acp-poll",
          agent: handle.snapshot.slug,
          reason: desired ? "token-rotated" : "agent-removed",
        }, "stopped loop");
      }
    }

    // Start loops for new desired entries.
    for (const [key, snapshot] of desiredByKey) {
      if (loops.has(key)) continue;
      const ctl = new AbortController();
      const childSignal = ctl.signal;
      // Also abort when the outer stop fires.
      stopController.signal.addEventListener("abort", () => ctl.abort(), { once: true });
      const done = runAgentLoop(snapshot, childSignal).catch((err) => {
        deps.logger.error({
          tag: "acp-poll",
          agent: snapshot.slug,
          err: errorSummary(err),
        }, "agent loop crashed");
      });
      loops.set(key, { snapshot, abortController: ctl, done });
      deps.logger.info({
        tag: "acp-poll",
        agent: snapshot.slug,
        companyId: snapshot.companyId,
      }, "started loop");
    }
  }

  // Initial reconcile + periodic. Kick the loop without blocking start().
  let reconcileTimer: NodeJS.Timeout | null = null;
  void reconcile();
  reconcileTimer = setInterval(() => {
    void reconcile();
  }, reconcileIntervalMs);
  // setInterval should not keep the process alive on its own; the
  // server's HTTP listener and DB pool are what hold it open.
  reconcileTimer.unref?.();

  return {
    async stop(drainTimeoutMs = 5_000): Promise<void> {
      stopController.abort();
      if (reconcileTimer) {
        clearInterval(reconcileTimer);
        reconcileTimer = null;
      }
      const drainPromise = Promise.allSettled([...loops.values()].map((l) => l.done));
      const timeoutPromise = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, drainTimeoutMs);
        t.unref?.();
      });
      await Promise.race([drainPromise, timeoutPromise]);
    },
    activeLoopCount: () => loops.size,
    reconcileNow: reconcile,
  };
}

async function ackQuietly(
  deps: AcpPollWorkerDeps,
  snapshot: AcpPollAgentSnapshot,
  envelopeId: string,
  signal: AbortSignal,
): Promise<void> {
  const url = `${deps.baseUrl}/api/acp/dispatch/agent-poll/${encodeURIComponent(envelopeId)}/ack`;
  try {
    await fetchWithTimeout(
      deps.fetch,
      url,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${snapshot.token}` },
      },
      10_000,
      signal,
    );
  } catch (err) {
    deps.logger.warn({
      tag: "acp-poll",
      agent: snapshot.slug,
      envelopeId,
      err: errorSummary(err),
    }, "ack failed (claim already delivered server-side; safe to ignore)");
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  outerSignal: AbortSignal,
): Promise<Response> {
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  timer.unref?.();
  const onOuterAbort = () => timeoutCtl.abort();
  outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await fetchImpl(url, { ...init, signal: timeoutCtl.signal });
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

function errorSummary(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "UnknownError", message: String(err) };
}

// Re-exported so tests can build their own sleep without dragging in
// `node:timers/promises`.
export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

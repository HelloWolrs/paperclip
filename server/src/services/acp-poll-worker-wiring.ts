// Concrete dependencies for the ACP outbound long-poll worker.
//
// `acp-poll-worker.ts` is dependency-injected for testability; this
// module supplies the real DB-backed implementations and wires them into
// `startAcpPollWorker`. Imported only from `server/src/index.ts` behind
// the `PAPERCLIP_ACP_POLL_ENABLED` feature flag.
//
// Spec: BASA-30556. Parent: BASA-30552.

import { eq, sql } from "drizzle-orm";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import {
  defaultSleep,
  startAcpPollWorker,
  type AcpPollAgentSnapshot,
  type AcpPollEnvelope,
  type AcpPollLogger,
  type AcpPollWorkerHandle,
} from "./acp-poll-worker.js";

const ACP_TOKEN_PREFIX = "ACP_AGENT_TOKEN_";

function envKeyToSlug(envKey: string): string {
  return envKey
    .replace(/^ACP_AGENT_TOKEN_/, "")
    .toLowerCase()
    .replace(/_/g, "-");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

// `agents.adapter_config.env` values follow the `EnvBinding` union from
// @paperclipai/shared: either a legacy plaintext string, a `{type:"plain",value}`
// wrapper (server-side normalization on write), or a `{type:"secret_ref",secretId,version?}`
// pointer. Returns the concrete token string for the first two shapes; returns
// null (and the caller logs) for secret_ref and any other unresolvable shape,
// because startup discovery cannot resolve secrets synchronously — those must
// flow through the secrets service.
export type ExtractAcpTokenResult =
  | { kind: "token"; value: string }
  | { kind: "empty" }
  | { kind: "secret_ref" }
  | { kind: "unknown" };

export function extractAcpToken(raw: unknown): ExtractAcpTokenResult {
  if (typeof raw === "string") {
    return raw.length > 0 ? { kind: "token", value: raw } : { kind: "empty" };
  }
  const wrapper = asRecord(raw);
  if (wrapper) {
    if (wrapper.type === "plain" && typeof wrapper.value === "string") {
      return wrapper.value.length > 0
        ? { kind: "token", value: wrapper.value }
        : { kind: "empty" };
    }
    if (wrapper.type === "secret_ref") {
      return { kind: "secret_ref" };
    }
  }
  return { kind: "unknown" };
}

export async function discoverAcpAgents(db: Db): Promise<AcpPollAgentSnapshot[]> {
  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents);

  const snapshots: AcpPollAgentSnapshot[] = [];
  for (const row of rows) {
    const adapterConfig = asRecord(row.adapterConfig);
    if (!adapterConfig) continue;
    const env = asRecord(adapterConfig.env);
    if (!env) continue;
    for (const [key, raw] of Object.entries(env)) {
      if (!key.startsWith(ACP_TOKEN_PREFIX)) continue;
      const extracted = extractAcpToken(raw);
      if (extracted.kind === "token") {
        snapshots.push({
          companyId: row.companyId,
          agentId: row.id,
          slug: envKeyToSlug(key),
          token: extracted.value,
        });
        continue;
      }
      if (extracted.kind === "secret_ref") {
        logger.warn(
          { tag: "acp-poll", agentId: row.id, envKey: key },
          "ACP token stored as secret_ref; startup discovery cannot resolve secrets. Bind via secrets service or store as plain.",
        );
        continue;
      }
      if (extracted.kind === "unknown") {
        logger.warn(
          { tag: "acp-poll", agentId: row.id, envKey: key, rawType: typeof raw },
          "ACP token env value has unrecognized shape; expected string or {type:'plain',value:string}",
        );
      }
    }
  }
  return snapshots;
}

// Wraps `issueService(db).create()` with the defence-in-depth assignee check
// described in the BASA-30556 threat model: the marketplace's Bearer-binds-slug
// gate is the primary control, this is the second layer.
export function makeCreateIssueFromDispatch(db: Db) {
  const issues = issueService(db);
  return async function createIssueFromDispatch(
    snapshot: AcpPollAgentSnapshot,
    envelope: AcpPollEnvelope,
  ): Promise<{ id: string; identifier: string } | null> {
    const payload = asRecord(envelope.payload);
    if (!payload) {
      logger.warn(
        { tag: "acp-poll", agent: snapshot.slug, envelopeId: envelope.id },
        "dispatch payload is not an object; dropping envelope",
      );
      return null;
    }
    const assigneeAgentId = payload.assigneeAgentId;
    if (assigneeAgentId !== undefined && assigneeAgentId !== snapshot.agentId) {
      logger.warn(
        {
          tag: "acp-poll",
          agent: snapshot.slug,
          envelopeId: envelope.id,
          expectedAgentId: snapshot.agentId,
          payloadAssigneeAgentId: assigneeAgentId,
        },
        "dispatch payload assigneeAgentId mismatch; dropping envelope (defence-in-depth)",
      );
      return null;
    }
    // Force the marketplace's tenant claim into the agent that holds this
    // token. companyId comes from the in-process agent row, never from
    // the envelope.
    const created = await issues.create(snapshot.companyId, {
      ...(payload as Parameters<typeof issues.create>[1]),
      assigneeAgentId: snapshot.agentId,
    });
    return { id: created.id, identifier: created.identifier ?? created.id };
  };
}

export async function bumpLastSuccessfulPoll(
  db: Db,
  agentId: string,
  at: Date,
): Promise<void> {
  const iso = at.toISOString();
  await db
    .update(agents)
    .set({
      metadata: sql`COALESCE(${agents.metadata}, '{}'::jsonb) || jsonb_build_object('lastSuccessfulAcpPollAt', ${iso}::text)`,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, agentId));
}

export interface StartAcpPollWorkerOptions {
  baseUrl: string;
  pollWaitSeconds?: number;
  reconcileIntervalMs?: number;
}

export function startAcpPollWorkerWithDeps(
  db: Db,
  options: StartAcpPollWorkerOptions,
): AcpPollWorkerHandle {
  const workerLogger: AcpPollLogger = {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  };
  return startAcpPollWorker({
    baseUrl: options.baseUrl,
    pollWaitSeconds: options.pollWaitSeconds,
    reconcileIntervalMs: options.reconcileIntervalMs,
    fetch: globalThis.fetch,
    nowMs: () => Date.now(),
    sleep: defaultSleep,
    logger: workerLogger,
    agentsSnapshot: () => discoverAcpAgents(db),
    createIssueFromDispatch: makeCreateIssueFromDispatch(db),
    bumpLastSuccessfulPoll: (agentId, at) => bumpLastSuccessfulPoll(db, agentId, at),
  });
}

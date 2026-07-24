import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import studioContractProjection from "../contracts/studio-programmatic-access-operations.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };

/**
 * Automat Robotic Workflows MCP Server.
 *
 * Stateless Streamable-HTTP endpoint (plain Vercel Function). Each tool forwards
 * to the studio public v1 API under /api/v1/projects/{projectId}/..., authenticating
 * with a Personal Access Token (pat_...) that acts as its owning user.
 *
 * Because a PAT spans every project its user can access, target selection uses
 * explicit selectors first, then remembered state. Remembered state is isolated
 * by token + logical connector identity when one is supplied; connector-less
 * callers retain a compatibility token-wide bucket.
 *
 * Contract reference: README.md (Tools section).
 */

// ---------------------------------------------------------------------------
// Config + per-request auth.
// ---------------------------------------------------------------------------
// The studio agent API origin — set STUDIO_API_BASE_URL in the Vercel env (the
// single source of truth; no fallback). Studio preview URLs change per deploy.
// Protected previews also need VERCEL_AUTOMATION_BYPASS_SECRET.
const STUDIO_API_BASE_URL = (process.env.STUDIO_API_BASE_URL ?? "").replace(/\/$/, "");
const VERCEL_BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

// Pass-through auth: the caller supplies their Studio personal access token
// (pat_…) as the connector api key; we forward it per-request as a Bearer to the
// studio v1 API. Nothing is stored or committed. Held in async-local storage for
// the request's lifetime.
const callerKey = new AsyncLocalStorage<string>();
// Connection-scoped target project (a PAT spans projects, so the credential no
// longer implies one). Explicit selectors are resolved per request.
const callerProject = new AsyncLocalStorage<string>();
const callerConnection = new AsyncLocalStorage<string>();
const studioDefaultProjectId = () => process.env.STUDIO_DEFAULT_PROJECT_ID || undefined;

// set_project state: the agent-selected project, persisted in Upstash Redis
// keyed by a hash of the caller's token and, when available, logical
// connector identity (connection_id / x-connection-id / mcp-session-id).
// This endpoint runs in STATELESS Streamable HTTP mode (no sessionIdGenerator
// configured), so mcp-handler never issues an Mcp-Session-Id — ordinary
// connectors that just point at the base MCP URL will never have one to send.
// The bucket falls back to a PAT-global compatibility scope only when no
// connector identity is present. Connector-scoped isolation (distinct
// connection_id/x-connection-id/mcp-session-id values per connector) remains
// recommended whenever multiple connectors share one PAT. The server is a
// stateless, multi-instance serverless function, so an in-process value can't
// survive across requests — the shared store is what lets `set_project` stick
// between calls and across cold starts. Precedence: ?project_id= >
// x-project-id header > remembered set_project selection >
// STUDIO_DEFAULT_PROJECT_ID.
//
// Falls back to an in-process Map when Redis env is absent (local dev / tests /
// a single stdio process) — there the Map genuinely persists for the process.
const REMEMBERED_PROJECT_TTL_S = 6 * 60 * 60; // 6h
const projectKey = (bucket: string) => `pat:project:${bucket}`;
const TOKEN_SELECTION_WARNING =
  "All callers sharing this PAT also share this remembered project. Prefer explicit project_id/x-project-id, a stable connection_id, or a unique PAT per bare connector.";
const PROJECT_SELECTION_GUIDANCE = {
  explicit:
    "Safest: send project_id on the URL or x-project-id on every call; explicit selectors take precedence.",
  connector:
    "For remembered selection, call set_project with connection_id, x-connection-id, or a client-supplied mcp-session-id.",
  tokenCaveat:
    "Without connector identity, set_project uses token scope and all callers sharing this PAT share one selection.",
} as const;

export interface RememberedProjectRedis {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: string, options: { ex: number }): Promise<unknown>;
}

const configuredRedis: RememberedProjectRedis | null =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
    : null;
let redis = configuredRedis;
const memFallback = new Map<string, { projectId: string; at: number }>();

/**
 * Test seam: clears the in-process `set_project` fallback map. The map is
 * module-scoped and persists across tests in one process — call this in a
 * test's setup/teardown before asserting on remembered-project behavior so
 * one test's `set_project` state can't leak into another.
 */
export function __resetMemFallbackForTests(): void {
  memFallback.clear();
}

/** Test seam for deterministic Redis-path coverage without live infrastructure. */
export function __setRedisForTests(client: RememberedProjectRedis | null): void {
  redis = client;
}

/** Restores the environment-configured Redis client after a test override. */
export function __resetRedisForTests(): void {
  redis = configuredRedis;
}

function tokenBucket(): string | null {
  const key = callerKey.getStore();
  if (!key) return null;
  const connection = callerConnection.getStore();
  // Prefer connector-scoped isolation when the caller supplied one; otherwise
  // fall back to a token-global bucket so callers with no connection_id /
  // x-connection-id (i.e. almost everyone, since this endpoint never issues
  // an Mcp-Session-Id) still get working `set_project` behavior.
  return connection
    ? createHash("sha256").update(key).update("\0").update(connection).digest("hex")
    : createHash("sha256").update(key).digest("hex");
}

async function rememberedProjectId(): Promise<string | undefined> {
  const bucket = tokenBucket();
  if (!bucket) return undefined;
  if (redis) {
    // Best-effort read: a Redis blip must never break auth. The local fallback
    // may contain a write that Redis failed to acknowledge on this instance.
    try {
      const remembered = (await redis.get<string>(projectKey(bucket))) ?? undefined;
      if (remembered) return remembered;
    } catch {
      // Fall through to the same-scope in-process fallback.
    }
  }
  const entry = memFallback.get(bucket);
  if (!entry) return undefined;
  if (Date.now() - entry.at > REMEMBERED_PROJECT_TTL_S * 1000) {
    memFallback.delete(bucket);
    return undefined;
  }
  return entry.projectId;
}

function rememberProjectInMemory(bucket: string, projectId: string): void {
  if (memFallback.size >= 1000) memFallback.clear();
  memFallback.set(bucket, { projectId, at: Date.now() });
}

async function rememberProject(projectId: string): Promise<void> {
  const bucket = tokenBucket();
  if (!bucket) return;
  if (redis) {
    try {
      await redis.set(projectKey(bucket), projectId, { ex: REMEMBERED_PROJECT_TTL_S });
      // Mirror every acknowledged Redis write locally so a later read outage
      // preserves connector continuity on this instance.
      rememberProjectInMemory(bucket, projectId);
      return;
    } catch {
      // Keep this selection usable on the current instance. The bucket keeps
      // the same connector-or-token scope selected by tokenBucket().
    }
  }
  rememberProjectInMemory(bucket, projectId);
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, authorization, x-api-key, x-project-id, x-connection-id, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

function extractKey(req: Request): string | null {
  const fromQuery = new URL(req.url).searchParams.get("api_key");
  if (fromQuery) return fromQuery;
  const fromXApiKey = req.headers.get("x-api-key");
  if (fromXApiKey) return fromXApiKey;
  const auth = req.headers.get("authorization");
  if (auth) return auth.replace(/^Bearer\s+/i, "").trim();
  return null;
}

function extractProjectId(req: Request): string | undefined {
  return new URL(req.url).searchParams.get("project_id") ?? req.headers.get("x-project-id") ?? undefined;
}

function extractConnectionId(req: Request): string | undefined {
  return (
    new URL(req.url).searchParams.get("connection_id") ??
    req.headers.get("x-connection-id") ??
    req.headers.get("mcp-session-id") ??
    undefined
  );
}

// ---------------------------------------------------------------------------
// Studio API client
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(public status: number, public apiCode: string, message: string, public issues?: unknown) {
    super(message);
  }
}

const STUDIO_STABLE_ERROR_CODES = new Set(
  studioContractProjection.operations.flatMap((operation) =>
    "stableErrorCodes" in operation ? operation.stableErrorCodes : [],
  ),
);

interface ApiOpts {
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

async function api(method: string, path: string, opts: ApiOpts = {}): Promise<any> {
  if (!STUDIO_API_BASE_URL) throw new ApiError(500, "config_error", "STUDIO_API_BASE_URL is not set on the MCP server.");
  const key = callerKey.getStore();
  if (!key) throw new ApiError(401, "unauthorized", "Missing API key.");

  // Single choke point for the internal route aliases → current PAT v1 routes.
  // Only characterized domains are accepted, so a stale alias can never leak
  // through as a Studio request.
  let resolvedPath = path;
  if (path.startsWith("/api/agent/")) {
    if (path === "/api/agent/schema") {
      resolvedPath = "/api/v1/schema";
    } else if (path === "/api/agent/projects") {
      // Project DISCOVERY — the one list that exists to find a projectId,
      // so it must not require one.
      resolvedPath = "/api/v1/projects";
    } else {
      const suffix = path.slice("/api/agent/".length);
      const domain = suffix.split("/")[0];
      const allowedDomains = new Set([
        "workflows",
        "sessions",
        "hitl",
        "secrets",
        "resources",
        "extractors",
      ]);
      if (!domain || !allowedDomains.has(domain)) {
        throw new ApiError(500, "config_error", `No Studio v1 route mapping exists for ${path}.`);
      }
      const projectId = callerProject.getStore() ?? (await rememberedProjectId()) ?? studioDefaultProjectId();
      if (!projectId) {
        throw new ApiError(
          400,
          "config_error",
          "Missing project id — call the set_project tool with the project UUID (preferred), or add ?project_id=<uuid> to the MCP URL / an x-project-id header / STUDIO_DEFAULT_PROJECT_ID."
        );
      }
      resolvedPath = `/api/v1/projects/${projectId}/${suffix}`;
    }
  }
  const url = new URL(STUDIO_API_BASE_URL + resolvedPath);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    accept: "application/json",
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  if (VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = VERCEL_BYPASS;

  const res = await fetch(url, {
    method,
    headers,
    body:
      opts.body !== undefined
        ? typeof opts.body === "string"
          ? opts.body
          : JSON.stringify(opts.body)
        : undefined,
  });
  const text = await res.text();
  let data: any ;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const apiCode = data?.code ?? data?.error ?? `http_${res.status}`;
    const message =
      res.status >= 500 ? "Studio request failed." : data?.message || data?.error || res.statusText || "Studio request failed.";
    throw new ApiError(res.status, String(apiCode), String(message), data?.issues);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Result + error helpers (MCP tool result shape)
// ---------------------------------------------------------------------------
const result = (data: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

function ourCode(status: number, apiCode?: string): string {
  if (
    apiCode &&
    ([
        "not_found",
        "validation_failed",
        "version_conflict",
        "conflict",
        "lifecycle_gated",
        "forbidden",
        "bad_request",
        "rate_limited",
        "unauthorized",
        "internal_error",
      ].includes(apiCode) ||
      STUDIO_STABLE_ERROR_CODES.has(apiCode))
  ) {
    return apiCode;
  }
  switch (status) {
    case 400: return "bad_request";
    case 401: return "unauthorized";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 409: return "conflict";
    case 422: return "validation_failed";
    case 429: return "rate_limited";
    default: return "internal_error";
  }
}

function fail(e: unknown, partialResult?: Record<string, unknown>) {
  if (e instanceof ApiError) {
    return result({
      error: {
        code: ourCode(e.status, e.apiCode),
        status: e.status,
        message: e.message,
        ...(e.issues ? { issues: e.issues } : {}),
      },
      ...(partialResult ? { partialResult } : {}),
    });
  }
  return result({
    error: { code: "internal_error", message: "Unexpected MCP server error." },
    ...(partialResult ? { partialResult } : {}),
  });
}

const toolFailure = (status: number, message: string, apiCode?: string, issues?: unknown) =>
  fail(new ApiError(status, apiCode ?? ourCode(status), message, issues));

// Pagination: our tools speak {limit, cursor}/{items, nextCursor}; the API speaks
// {page, pageSize}/{..., totalPages, currentPage}. Translate the cursor as a page number.
const toPage = (cursor?: string) => {
  const p = cursor ? parseInt(cursor, 10) : 1;
  return Number.isFinite(p) && p > 0 ? p : 1;
};
const nextCursor = (currentPage: number, totalPages: number) =>
  currentPage < totalPages ? String(currentPage + 1) : null;
const durMs = (start?: string | null, end?: string | null) =>
  start && end ? Math.max(0, new Date(end).getTime() - new Date(start).getTime()) : null;

// ---------------------------------------------------------------------------
// Ported from studio/lib/builder/ai/tools.ts — apply a composite patch to a
// workflow definition (read-modify-write; the v1 API only accepts a full PUT).
// ---------------------------------------------------------------------------
const isPlainObject = (v: any): v is Record<string, any> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: any, patch: any): any {
  if (!isPlainObject(patch)) return patch;
  if (!isPlainObject(base)) return patch;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function applyNodeOps(next: any, ops: any) {
  if (ops.remove?.length) {
    const removeSet = new Set(ops.remove);
    const unknown = ops.remove.filter((n: string) => !next.nodes.some((nd: any) => nd.name === n));
    if (unknown.length)
      throw new Error(`Cannot remove unknown node(s): ${unknown.join(", ")}. Nodes: ${next.nodes.map((nd: any) => nd.name).join(", ")}`);
    next.nodes = next.nodes.filter((nd: any) => !removeSet.has(nd.name));
    next.edges = (next.edges ?? []).filter((e: any) => !removeSet.has(e.from) && !removeSet.has(e.to));
  }
  if (ops.add?.length) {
    const existing = new Set(next.nodes.map((nd: any) => nd.name));
    for (const nn of ops.add) {
      if (existing.has(nn.name)) throw new Error(`Cannot add node "${nn.name}": a node with that name already exists.`);
      next.nodes.push(nn);
      existing.add(nn.name);
    }
  }
  if (ops.update?.length) {
    for (const { name, patch: np } of ops.update) {
      const idx = next.nodes.findIndex((nd: any) => nd.name === name);
      if (idx === -1)
        throw new Error(`Cannot update unknown node "${name}". Nodes: ${next.nodes.map((nd: any) => nd.name).join(", ")}`);
      const merged = { ...next.nodes[idx], ...np };
      const newName = typeof np.name === "string" ? np.name : undefined;
      if (newName && newName !== name) {
        if (next.nodes.some((nd: any, i: number) => i !== idx && nd.name === newName))
          throw new Error(`Cannot rename "${name}" to "${newName}": that name is already taken.`);
        next.edges = (next.edges ?? []).map((e: any) => ({
          ...e,
          from: e.from === name ? newName : e.from,
          to: e.to === name ? newName : e.to,
        }));
      }
      next.nodes[idx] = merged;
    }
  }
}

const edgeMatches = (edge: any, target: any) =>
  target.from === edge.from &&
  target.to === edge.to &&
  (Object.hasOwn(target, "handle") ? target.handle === edge.handle : !Object.hasOwn(edge, "handle"));

function applyEdgeOps(next: any, ops: any) {
  if (ops.remove?.length) {
    for (const target of ops.remove) {
      const matches = (next.edges ?? []).filter((edge: any) => edgeMatches(edge, target)).length;
      if (matches !== 1) {
        throw new Error(
          `Cannot remove edge ${target.from} → ${target.to}${target.handle !== undefined ? ` (handle "${target.handle}")` : " (no handle)"}: expected exactly one match, found ${matches}.`,
        );
      }
    }
    next.edges = (next.edges ?? []).filter(
      (edge: any) => !ops.remove.some((target: any) => edgeMatches(edge, target)),
    );
  }
  if (ops.update?.length) {
    for (const { from, to, handle, patch } of ops.update) {
      const target = { from, to, ...(handle !== undefined ? { handle } : {}) };
      const matches = next.edges
        .map((edge: any, index: number) => (edgeMatches(edge, target) ? index : -1))
        .filter((index: number) => index >= 0);
      if (matches.length !== 1) {
        throw new Error(
          `Cannot update edge ${from} → ${to}${handle !== undefined ? ` (handle "${handle}")` : " (no handle)"}: expected exactly one match, found ${matches.length}.`,
        );
      }
      next.edges[matches[0]] = { ...next.edges[matches[0]], ...patch };
    }
  }
  if (ops.add?.length) {
    const known = new Set(next.nodes.map((nd: any) => nd.name));
    const unknown = ops.add.flatMap((e: any) => {
      const m: string[] = [];
      if (!known.has(e.from)) m.push(`from "${e.from}"`);
      if (!known.has(e.to)) m.push(`to "${e.to}"`);
      return m;
    });
    if (unknown.length) throw new Error(`Cannot add edge with unknown endpoint(s): ${unknown.join(", ")}.`);
    next.edges = [...(next.edges ?? []), ...ops.add];
  }
}

/**
 * Applies the MCP composite workflow patch without mutating the current definition.
 *
 * This export is a test seam for the existing read-modify-write behavior; the
 * endpoint remains the owner of the patch implementation.
 */
export function applyWorkflowPatch(current: any, patch: any): any {
  const next = JSON.parse(JSON.stringify(current ?? {}));
  if (!Array.isArray(next.nodes)) next.nodes = [];
  if (!Array.isArray(next.edges)) next.edges = [];
  if (patch.nodes !== undefined) applyNodeOps(next, patch.nodes);
  if (patch.edges !== undefined) applyEdgeOps(next, patch.edges);
  if (patch.settings !== undefined)
    next.settings = patch.settings === null ? null : deepMerge(next.settings, patch.settings);
  for (const [k, v] of Object.entries(patch)) {
    if (k === "nodes" || k === "edges" || k === "settings") continue;
    if (v !== undefined) next[k] = v;
  }
  return next;
}

// Shared input schema pieces
const WorkflowStatus = z.enum(["development", "preview", "active", "disabled"]);
const RunStatus = z.enum(["pending", "queued", "executing", "paused", "completed", "failed", "canceled"]);
const Lifecycle = z.enum(["development", "preview", "active"]);
const ResourceSource = z.enum(["manual", "api", "workflow"]);
const ResourceApiConfig = z
  .object({
    url: z.string().url(),
    schedule: z.string().min(1).optional(),
  })
  .strict();
// Shared, concise execution model — folded into the definition/patch param
// descriptions so an agent can author nodes without a separate get_workflow_schema
// call (which remains the full reference). Kept tight to respect the ~2KB budget.
const CODE_MODEL =
  "Node types: start, end, block, decision, document, hitl. A `block` is deterministic `code` (mode:'code', the default — no LLM tokens) or AI `execute` (mode:'execute' — costs tokens; prefer code). Block code runs async (await + TypeScript) and must `return` a value; in-scope globals include `page`/`context` (Playwright), `$('NodeName')`, `secrets`, `helpers`, `projectResources` (including update/merge), `logger`, `emit`, `state`, and `files`. A `decision` routes by ordered boolean `branches:[{id,label?,expression}]` (scope: page/context/$/logger/helpers/projectResources plus runtime libraries; first true wins) — one outgoing edge per branch with `handle:<branch id>` plus one `handle:'else'` edge for no-match. Browser recording: settings.browser={headless:false,recording:true}.";
const CODE_EXAMPLE =
  "Example block — {type:'block',name:'Fetch',mode:'code',position:{x:160,y:0},code:\"await page.goto('https://example.com'); return { title: await page.title() };\"}";

// Canonical authoring docs, served on demand by the get_docs tool (so they can be
// detailed without always-on context cost). This is where an agent learns HOW to
// write a code/decision node — the JSON Schema only describes structure.
const DOCS = {
  overview:
    "Automat workflows let an agent build, deploy, and schedule deterministic RPA that runs on its own with no LLM tokens. A workflow is a graph: exactly one `start`, one+ `end`, and `block`/`decision`/`document`/`hitl` nodes between, joined by edges. Build loop: get_docs (this) → get_workflow_schema (exact JSON shape) → create_workflow OR read_workflow(view:'graph') then edit → run_workflow → get_run(include:['timeline','io']). Editing: edit_node_code for find/replace inside one node's code (preferred for code changes — send only the changed snippet), edit_workflow(patch) for structural changes (add/remove/rename nodes, rewire edges, settings; nodes.update replaces fields wholesale). Graph view shows per-node codeChars — read a big node with view:'node' before editing it.",
  codeNodes: {
    summary:
      "block mode:'code' is deterministic (no tokens). The `code` runs as the body of an async function — use await, TypeScript supported — and must `return` a value (becomes the node's output; the run's final output is the last node's return, surfaced under output.output).",
    globals: {
      "$('NodeName')":
        "Read another node's return value, e.g. $('Fetch').items. The only way to access prior output; valid names are the node's upstream nodes (see read_workflow view:'graph').",
      fetch: "Standard fetch() for HTTP/API calls.",
      "page, context": "Playwright Page/BrowserContext — present only when settings.browser is set.",
      secrets: "Project secrets by name: secrets.MY_KEY (set via set_secrets; injected at runtime).",
      "helpers, projectResources":
        "helpers.<name> are shared functions defined in the definition's top-level `helpers:[{name,description?,code}]` array (read them via read_workflow view:'full'; graph view lists their names). projectResources.<name> are named project data resources; code blocks and helpers can persist workflow-owned resources with projectResources.update(name,value) / merge(name,patch).",
      logger: "logger.info(msg) / logger.error(msg).",
      "emit, state":
        "emit(title,eventName,data?,options?) is available in code blocks. state exposes sessions.previous, artifacts, claim, and setSessionField in code blocks; availability depends on workflow settings and runtime support.",
      files:
        "files.download/fromDownload/upload/getSignedUrl provide run-scoped file I/O in code blocks and helpers. Use projectResources.<name>.local_path for attached project files.",
    },
  },
  nodeTypes: {
    start: "Entry point (exactly one).",
    end: "Exit point; passes through the previous node's output.",
    block: "Runs code (mode:'code') or an AI agent (mode:'execute' — costs tokens; prefer code). Fields: name, position, mode, code | (instructions + execute).",
    decision:
      "Ordered `branches:[{id, label?, expression}]` — each expression is a JS boolean with page/context/$/logger/helpers/projectResources and runtime libraries (not code-block-only secrets/emit/state/files); the first true branch wins. Route one outgoing edge per branch with handle=<branch id>, plus exactly one catch-all edge with handle:'else' (label it via the node's `elseLabel`). Branch ids are stable routing keys — never 'else', never renamed when the label changes. (Legacy binary form — a single `expression` with edges handle:'true'/'false' — still runs but is deprecated; author `branches`.)",
    document: "Extract data from files via an extractor (extractorId + fileInputs). Find ids with list_extractors.",
    hitl: "Pause for a human: prompt + actions:[{id,label}]. Outgoing edges route by action id or 'timeout'.",
  },
  browser:
    "Set settings.browser = { headless:false, recording:true } to capture a recording (get_run include:['recording']). `page` is Playwright. Tip: a native post-login dialog (e.g. a 'breached password' bubble) can swallow real input clicks and stall navigation — if so, click in-page: await page.evaluate(() => document.querySelector(sel).click()).",
  secrets:
    "Store with set_secrets({secrets:[{key,value}]}); read at runtime as secrets.KEY inside a code block. list_secrets never returns values.",
  schedules:
    "create_schedule with an RFC 5545 recurrenceRule (e.g. 'FREQ=DAILY;BYHOUR=9'), evaluated in UTC. Run input comes from a linked project resource (inputResourceName). Only create/enable schedules after the workflow is `active` and the user has signed off.",
  resources:
    "The PAT API is the environment control plane for project data resources; project files are separate. source controls behavior: manual is operator-managed, api may refresh from config.url, and workflow may be written by running code, so automatic API/workflow writes can later overwrite values set here. Prefer stable resourceId for get/update/delete. Name + lifecycle is a bounded convenience lookup and can race concurrent changes; name alone works only when unique across lifecycles. test_resource_api fetches and parses a URL without persisting a resource.",
  lifecycle: {
    policy:
      "Agents MUST follow this rollout ladder. Never skip steps or promote to `active` without explicit user approval.",
    development:
      "DEFAULT for all new/changed workflows. Keep status `development` while iterating. If a workflow explicitly implements a `dryRun` input, prefer `{ dryRun: true }`; this is a workflow convention, not a platform-enforced side-effect sandbox, so inspect the workflow before relying on it. Manual runs only — do not treat development workflows as production-ready.",
    preview:
      "Promote with update_workflow(status:'preview') ONLY when ready for the HUMAN to test end-to-end (real emails/side effects if appropriate). Tell the user the workflow is in preview and ready for their review.",
    active:
      "Promote with update_workflow(status:'active') ONLY after the user explicitly confirms go-live. Required before production schedules and unattended cron. Never activate on your own.",
    disabled: "Pause production; disabling auto-pauses schedules.",
    testingTips:
      "development + a workflow-defined dryRun:true convention → lower-risk agent iteration after inspecting the implementation (inspect get_run include:['io']). preview → user validation run. active → production.",
  },
  examples: [
    { title: "HTTP fetch → return", code: "const r = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');\nreturn { topIds: (await r.json()).slice(0, 5) };" },
    { title: "Chain nodes with $()", code: "const ids = $('Fetch').topIds;\nreturn { count: ids.length };" },
    { title: "Browser code block", code: "await page.goto('https://example.com');\nreturn { title: await page.title() };" },
    { title: "Use a secret", code: "const res = await fetch('https://api.example.com', { headers: { Authorization: 'Bearer ' + secrets.API_TOKEN } });\nreturn await res.json();" },
    {
      title: "Decision node (multiway) + edges",
      code:
        "// node\n{ type:'decision', name:'Has Rows', position:{x:400,y:0},\n  branches:[{ id:'has-rows', label:'Rows found', expression: \"$('Detect Rows').count > 0\" }],\n  elseLabel:'No rows' }\n// edges — one per branch id, plus the required 'else' catch-all\n[{ from:'Has Rows', to:'Process Rows', handle:'has-rows' },\n { from:'Has Rows', to:'End', handle:'else' }]",
    },
  ],
};
const DOCS_TOPICS = ["overview", "codeNodes", "nodeTypes", "browser", "secrets", "schedules", "resources", "lifecycle", "examples"] as const;

const DefinitionInput = z
  .record(z.string(), z.unknown())
  .describe(
    `Full @automat/runtime workflow definition: { name, description?, settings, nodes[], edges[], inputSchema?, outputSchema? }. ${CODE_MODEL} ${CODE_EXAMPLE} Call get_workflow_schema for the full field reference. Validated server-side.`,
  );
const WorkflowPatchInput = z
  .object({
    nodes: z
      .object({
        add: z.array(z.record(z.string(), z.unknown())).optional(),
        update: z.array(z.object({ name: z.string(), patch: z.record(z.string(), z.unknown()) })).optional(),
        remove: z.array(z.string()).optional(),
      })
      .optional(),
    edges: z
      .object({
        add: z.array(z.record(z.string(), z.unknown())).optional(),
        update: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              handle: z.string().optional(),
              patch: z.record(z.string(), z.unknown()),
            }),
          )
          .optional(),
        remove: z
          .array(
            z.object({
              from: z.string(),
              to: z.string(),
              handle: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  })
  .passthrough()
  .describe(
    `Composite patch — send only what changes: { nodes:{add[],update[{name,patch}],remove[]}, edges:{add[],update[{from,to,handle?,patch}],remove[]}, ...top-level } (settings deep-merges; others replace). Edge remove/update identities include handle (omitted means an edge with no handle). Applied: nodes.remove → add → update → edges.remove → update → add → top-level. ${CODE_MODEL} ${CODE_EXAMPLE}`,
  );
const limit = z.number().int().min(1).max(100).describe("Page size (default 25, max 100).").optional();
const cursor = z.string().describe("Pagination cursor from a previous response's nextCursor.").optional();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EXTERNAL_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPSERT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const REMOVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// Shape mappers (API → our documented tool output)
const metaOf = (w: any) => ({
  workflowId: w.id,
  versionId: w.activeVersionId ?? null,
  versionNumber: w.activeVersionNumber ?? null,
  status: w.status,
  apiEnabled: w.apiEnabled,
  apiUrlSlug: w.apiUrlSlug ?? null,
});

const mapWorkflow = (w: any) => ({
  workflowId: w.id,
  name: w.name,
  description: w.description ?? null,
  status: w.status,
  activeVersionId: w.activeVersionId ?? null,
  apiEnabled: w.apiEnabled,
  apiUrlSlug: w.apiUrlSlug ?? null,
  sessionCount: w.sessionCount ?? null,
  lastRunAt: w.lastRunAt ?? null,
  updatedAt: w.updatedAt,
});

// Resolve resource ids through the exact-name list filter. A resource row is
// uniquely identified by UUID; name-only compatibility lookups scan every
// bounded page and succeed only when exactly one lifecycle row matches.
// Studio secrets are Doppler-backed and NAME-keyed; every secrets call must
// identify the Doppler project slug + config name. Tool inputs override the
// env defaults (STUDIO_DOPPLER_PROJECT / STUDIO_DOPPLER_CONFIG).
const DOPPLER_PROJECT_DEFAULT = process.env.STUDIO_DOPPLER_PROJECT || undefined;
const DOPPLER_CONFIG_DEFAULT = process.env.STUDIO_DOPPLER_CONFIG || undefined;
function dopplerQuery(project?: string, config?: string): { project: string; config: string } {
  const p = project ?? DOPPLER_PROJECT_DEFAULT;
  const c = config ?? DOPPLER_CONFIG_DEFAULT;
  if (!p || !c) {
    throw new ApiError(400, "bad_request", "Secrets need a Doppler project + config — pass dopplerProject/dopplerConfig or set STUDIO_DOPPLER_PROJECT/STUDIO_DOPPLER_CONFIG.");
  }
  return { project: p, config: c };
}
const dopplerProjectInput = z.string().describe("Doppler project slug (defaults to STUDIO_DOPPLER_PROJECT).").optional();
const dopplerConfigInput = z.string().describe("Doppler config name (defaults to STUDIO_DOPPLER_CONFIG).").optional();
async function findResources(name: string, lifecycle?: string): Promise<any[]> {
  const resources: any[] = [];
  for (let page = 1; page <= FILTER_SCAN_MAX_PAGES; page++) {
    const response = await api("GET", "/api/agent/resources", {
      query: { name, lifecycle, page, pageSize: FILTER_SCAN_PAGE_SIZE },
    });
    resources.push(...(response.resources ?? []));
    const totalPages = response.totalPages ?? page;
    if (page >= totalPages) return resources;
  }
  throw new ApiError(
    500,
    "internal_error",
    `Resource lookup for "${name}" exceeded the ${FILTER_SCAN_MAX_PAGES * FILTER_SCAN_PAGE_SIZE}-row safety bound.`,
    [{ code: "scan_truncated", continuationPage: FILTER_SCAN_MAX_PAGES + 1 }],
  );
}

async function findResource(name: string, lifecycle?: string): Promise<any | null> {
  const resources = await findResources(name, lifecycle);
  if (resources.length > 1) {
    throw new ApiError(
      409,
      "conflict",
      lifecycle
        ? `Multiple resources matched name "${name}" and lifecycle "${lifecycle}"; use resourceId.`
        : `Resource name "${name}" exists in multiple lifecycles; provide lifecycle or resourceId.`,
    );
  }
  return resources[0] ?? null;
}

const ResourceIdentifierInput = z
  .object({
    resourceId: z.string().uuid().optional(),
    name: z.string().min(1).optional(),
    lifecycle: Lifecycle.optional(),
  })
  .superRefine((value, context) => {
    if (value.resourceId) return;
    if (!value.name) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide resourceId or name." });
    }
  });

const FILTER_SCAN_PAGE_SIZE = 500;
const FILTER_SCAN_MAX_PAGES = 20;
const SCHEDULE_RECONCILE_PAGE_SIZE = 200;
const SCHEDULE_RECONCILE_MAX_PAGES = 20;
type FilterCursor = { page: number; index: number };

function decodeFilterCursor(value?: string): FilterCursor {
  if (!value || /^\d+$/.test(value)) return { page: toPage(value), index: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<FilterCursor>;
    if (
      Number.isInteger(parsed.page) &&
      Number.isInteger(parsed.index) &&
      (parsed.page ?? 0) > 0 &&
      (parsed.index ?? -1) >= 0
    ) {
      return { page: parsed.page as number, index: parsed.index as number };
    }
  } catch {
    // Characterized below as a normal tool failure.
  }
  throw new ApiError(400, "bad_request", "Invalid pagination cursor.");
}

const encodeFilterCursor = (value: FilterCursor) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

const mapResource = (resource: any) => ({
  resourceId: resource.id,
  name: resource.name,
  kind: "data",
  description: resource.description ?? null,
  value: resource.value,
  source: resource.source,
  config: resource.source === "api" ? (resource.config ?? null) : null,
  lifecycle: resource.lifecycle ?? null,
  lastFetchedAt: resource.lastFetchedAt ?? null,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt,
});

// Studio's PUT/POST resource routes are contractually 200/201-with-body; a
// success status carrying no resource is a Studio/network anomaly, not an
// empty result. Fail closed with a clear error instead of silently mapping
// undefined (PUT) or defaulting to an empty array that reads as "0 created"
// (POST).
function expectResource(response: any): any {
  if (!response?.resource) {
    throw new ApiError(502, "internal_error", "Studio returned a success status without the updated resource.");
  }
  return mapResource(response.resource);
}

function expectResources(response: any): any[] {
  if (!response?.resources?.length) {
    throw new ApiError(502, "internal_error", "Studio returned a success status without any created resources.");
  }
  return response.resources.map(mapResource);
}

async function findScheduleForReconciliation(workflowId: string, scheduleId: string): Promise<any | null> {
  for (let page = 1; page <= SCHEDULE_RECONCILE_MAX_PAGES; page++) {
    const response = await api("GET", `/api/agent/workflows/${workflowId}/schedules`, {
      query: { page, pageSize: SCHEDULE_RECONCILE_PAGE_SIZE },
    });
    const schedule = (response.schedules ?? []).find((candidate: any) => candidate.id === scheduleId);
    if (schedule) return schedule;
    if (page >= (response.totalPages ?? page)) return null;
  }
  return null;
}

async function listFilteredResources(args: {
  search: string;
  lifecycle?: string;
  limit: number;
  cursor?: string;
}) {
  let { page, index } = decodeFilterCursor(args.cursor);
  const items: any[] = [];
  const query = args.search.toLowerCase();

  for (let scanned = 0; scanned < FILTER_SCAN_MAX_PAGES; scanned++) {
    const response = await api("GET", "/api/agent/resources", {
      query: { lifecycle: args.lifecycle, page, pageSize: FILTER_SCAN_PAGE_SIZE },
    });
    const resources = response.resources ?? [];
    const totalPages = response.totalPages ?? page;

    for (let currentIndex = index; currentIndex < resources.length; currentIndex++) {
      const resource = resources[currentIndex];
      if (!(resource.name ?? "").toLowerCase().includes(query)) continue;
      items.push(resource);
      if (items.length === args.limit) {
        const hasMoreOnPage = currentIndex + 1 < resources.length;
        const next =
          hasMoreOnPage || page < totalPages
            ? encodeFilterCursor({
                page: hasMoreOnPage ? page : page + 1,
                index: hasMoreOnPage ? currentIndex + 1 : 0,
              })
            : null;
        return { items, nextCursor: next, truncated: false };
      }
    }

    if (page >= totalPages) return { items, nextCursor: null, truncated: false };
    page += 1;
    index = 0;
  }

  return {
    items,
    nextCursor: encodeFilterCursor({ page, index }),
    truncated: true,
  };
}

const MIN_DEFINITION = (name: string) => ({
  name,
  nodes: [
    { type: "start", name: "Start", position: { x: 0, y: 0 } },
    { type: "end", name: "End", position: { x: 240, y: 0 } },
  ],
  edges: [{ from: "Start", to: "End" }],
  settings: {},
});

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
const baseHandler = createMcpHandler(
  (server) => {
    // ---- Context & schema ----
    server.registerTool(
      "list_projects",
      {
        title: "List projects",
        description:
          "Lists projects this token can access and bounded project-selection guidance. Allowlist-scoped tokens see only their allowlisted projects. Returns the existing { items, nextCursor } fields plus projectSelection with explicit-selector, connector-scope, and token-scope guidance.",
        inputSchema: { limit, cursor },
        annotations: RO,
      },
      async ({ limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/projects", { query: { page, pageSize: lim ?? 25 } });
          const items = (r.projects ?? []).map((p: any) => ({ projectId: p.id, name: p.name }));
          return result({
            items,
            nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page),
            projectSelection: PROJECT_SELECTION_GUIDANCE,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "set_project",
      {
        title: "Set project",
        description:
          "Remembers the target Studio project after validating access. Precedence is project_id query → x-project-id header → remembered set_project → STUDIO_DEFAULT_PROJECT_ID. With connection_id, x-connection-id, or a client-supplied mcp-session-id, memory is isolated to this PAT + connector. Only when no connector identity exists, compatibility memory is PAT-wide and shared by every caller using that PAT. Explicit selectors are safest. Returns the existing fields plus selectionScope:'connector'|'token'; token scope also returns a warning.",
        inputSchema: {
          projectId: z.string().uuid().describe("The Studio project UUID — discover it with list_projects."),
        },
        annotations: UPSERT,
      },
      async ({ projectId }) => {
        try {
          // Validate against the DISCOVERY listing (an all-projects token gets
          // an empty-but-200 workflows list even for a nonexistent project id,
          // so probing a project-scoped route can't tell a typo from an empty
          // project). Walk the pages until the id shows up.
          const maxValidationPages = 100;
          let found = false;
          let totalPages = 1;
          for (let page = 1; page <= maxValidationPages && !found; page++) {
            const r = await api("GET", "/api/agent/projects", { query: { page, pageSize: 100 } });
            found = (r.projects ?? []).some((p: any) => p.id === projectId);
            totalPages = r.totalPages ?? 1;
            if (page >= totalPages) break;
          }
          if (!found && totalPages > maxValidationPages) {
            return toolFailure(
              500,
              "Project validation reached its 10,000-project safety bound before finding the requested id. Pin project_id on the connection or narrow the PAT project allowlist.",
              "internal_error",
              { truncated: true, continuationPage: maxValidationPages + 1 },
            );
          }
          if (!found) {
            return toolFailure(
              404,
              `Project ${projectId} is not accessible to this token — call list_projects to see the available projects.`,
            );
          }
          await rememberProject(projectId);
          const selectionScope = callerConnection.getStore() ? "connector" : "token";
          return result({
            projectId,
            validated: true,
            selectionScope,
            ...(selectionScope === "token" ? { warning: TOKEN_SELECTION_WARNING } : {}),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "list_runtime_versions",
      {
        title: "List runtime versions",
        description:
          "Lists the Automat runtime versions a workflow can be pinned to. get_workflow_schema and create_workflow default to the latest. Returns: { versions: [{ version, isLatest }] }.",
        annotations: RO,
      },
      async () =>
        result({
          versions: [{ version: "latest", isLatest: true }],
          note: "Studio does not expose an endpoint that enumerates available runtime versions, so this list is always just 'latest'. You can still pin an exact version string via create_workflow(runtimeVersion)/edit_workflow — Studio does not validate the pin against real availability at save time.",
        }),
    );

    server.registerTool(
      "get_docs",
      {
        title: "Get authoring docs",
        description:
          "How to author Automat workflows: code-node globals ($('NodeName'), fetch, secrets), async/return semantics, node types, browser/recording, schedules, resources, and worked examples. CALL THIS FIRST when building or editing a workflow. Pass `topic` to return just one section.",
        inputSchema: {
          topic: z.enum(DOCS_TOPICS).describe("Optional: return only this section.").optional(),
        },
        annotations: RO,
      },
      async ({ topic }) => result(topic ? { [topic]: (DOCS as Record<string, unknown>)[topic] } : { topics: DOCS_TOPICS, ...DOCS }),
    );

    server.registerTool(
      "get_workflow_schema",
      {
        title: "Get workflow schema",
        description:
          "Returns the workflow definition JSON Schema (exact field shapes for nodes, edges, settings). The schema always reflects the Runtime version actually installed on the Studio deployment — `runtimeVersion` is accepted and echoed back but does not select a different historical schema. Returns: { runtimeVersion, jsonSchema }.",
        inputSchema: { runtimeVersion: z.string().describe("Advisory only — echoed back, does not change the returned schema. Defaults to 'latest'.").optional() },
        annotations: RO,
      },
      async ({ runtimeVersion }) => {
        try {
          const r = await api("GET", "/api/agent/schema", { query: { runtimeVersion } });
          return result({ runtimeVersion: r.requestedRuntimeVersion ?? runtimeVersion ?? "latest", jsonSchema: r.schema });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Workflows ----
    server.registerTool(
      "list_workflows",
      {
        title: "List workflows",
        description:
          "Lists workflows in the project (scoped to the API key). Use to find a workflow's id. Returns: { items: [{ workflowId, name, status, activeVersionId, apiEnabled, apiUrlSlug, updatedAt }], nextCursor }.",
        inputSchema: { status: WorkflowStatus.optional(), search: z.string().optional(), limit, cursor },
        annotations: RO,
      },
      async ({ status, search, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/workflows", {
            query: { status, search, page, pageSize: lim ?? 25 },
          });
          const items = (r.workflows ?? []).map(mapWorkflow);
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "create_workflow",
      {
        title: "Create workflow",
        description:
          "Creates a new workflow and its first version (status defaults to development — keep it there while iterating). Omit `definition` for a minimal start → end scaffold. Returns: { workflowId, versionId, versionNumber, status }. See get_docs topic:'lifecycle' for the development → preview → active rollout policy.",
        inputSchema: {
          name: z.string(),
          description: z.string().optional(),
          definition: DefinitionInput.optional(),
          runtimeVersion: z.string().describe("Defaults to 'latest'.").optional(),
        },
        annotations: CREATE,
      },
      async ({ name, description, definition, runtimeVersion }) => {
        try {
          const def = {
            ...(definition ?? MIN_DEFINITION(name)),
            name,
            ...(description !== undefined ? { description } : {}),
            ...(runtimeVersion !== undefined ? { runtimeVersion } : {}),
          };
          const r = await api("POST", "/api/agent/workflows", { body: { definition: def } });
          return result({
            workflowId: r.workflow?.id,
            versionId: r.version?.id,
            versionNumber: r.version?.versionNumber,
            status: r.workflow?.status ?? "development",
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "copy_workflow",
      {
        title: "Copy workflow",
        description:
          "Clones an existing workflow's active version into a new workflow in the same project. Returns: { workflowId, name }.",
        inputSchema: { workflowId: z.string(), name: z.string().optional() },
        annotations: CREATE,
      },
      async ({ workflowId, name }) => {
        try {
          const src = await api("GET", `/api/agent/workflows/${workflowId}`);
          const def = src.workflow?.definition;
          if (!def) return toolFailure(404, "Source workflow has no active version to copy.");
          const newName = name ?? `Copy of ${src.workflow?.name ?? "workflow"}`;
          const created = { ...def, name: newName };
          const r = await api("POST", "/api/agent/workflows", { body: { definition: created } });
          return result({ workflowId: r.workflow?.id, name: r.workflow?.name ?? newName });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "read_workflow",
      {
        title: "Read workflow",
        description:
          "Reads a workflow's active definition. ALWAYS read before editing. view: 'graph' (nodes/edges + metadata — no code bodies, but per-node codeChars, decision branches/elseLabel, and a helpers index so you know what to fetch), 'node' (one node incl. its code, needs nodeName), 'full' (entire definition incl. helpers' code). TIERS: 'full' and 'node' return definition JSON and require an authorship-tier PAT (author role + write token) — expect a 403 'forbidden' otherwise; 'graph' works with any token (degrading to node names/types + edges without authorship). Returns the view plus _meta — pass _meta.versionId as expectedActiveVersionId to edit_workflow/edit_node_code.",
        inputSchema: {
          workflowId: z.string(),
          view: z.enum(["graph", "node", "full"]),
          nodeName: z.string().describe("Required when view='node'.").optional(),
        },
        annotations: RO,
      },
      async ({ workflowId, view, nodeName }) => {
        try {
          if (view === "node" && !nodeName) {
            return toolFailure(400, "nodeName is required when view='node'.");
          }
          // Definition JSON (view full/node) is AUTHORSHIP-tier on the studio
          // API. full/node pass the view through and surface the server's 403
          // for read/write-only tokens. graph tries the rich client-side
          // projection first (needs the full definition) and degrades to the
          // server's lean view=graph (names/types + edges) on a tier 403.
          const apiView = view === "graph" ? "full" : view;
          let r: any;
          try {
            r = await api("GET", `/api/agent/workflows/${workflowId}`, { query: { view: apiView, nodeName } });
          } catch (e) {
            if (view === "graph" && e instanceof ApiError && e.status === 403) {
              const lean = await api("GET", `/api/agent/workflows/${workflowId}`, { query: { view: "graph" } });
              const lw = lean.workflow;
              if (!lw) return toolFailure(404, "Workflow not found.");
              return result({
                _meta: metaOf(lw),
                ...(lw.graph ?? {}),
                note: "Lean graph (node names/types + edges): this token has no authorship tier, so the definition-derived fields (positions, expressions, schemas, settings) are unavailable.",
              });
            }
            throw e;
          }
          const w = r.workflow;
          if (!w) return toolFailure(404, "Workflow not found.");
          const meta = metaOf(w);
          if (view === "node") {
            // Server-resolved: a missing node 404s at the API and surfaces via fail().
            return result({ _meta: meta, node: w.node ?? null });
          }
          const def = w.definition ?? null;
          if (!def) return result({ _meta: meta, definition: null, note: "Workflow has no active version yet." });
          if (view === "full") return result({ _meta: meta, definition: def });
          // graph (rich): strip per-node code bodies, keep routing-critical fields.
          // codeChars tells the agent how big a node's code is before fetching it
          // with view:'node'; branches/elseLabel are the decision routing logic.
          const nodes = (def.nodes ?? []).map((n: any) => ({
            name: n.name, type: n.type, position: n.position,
            ...(n.mode ? { mode: n.mode } : {}),
            ...(typeof n.code === "string" ? { codeChars: n.code.length } : {}),
            ...(n.expression ? { expression: n.expression } : {}),
            ...(n.branches ? { branches: n.branches } : {}),
            ...(n.elseLabel ? { elseLabel: n.elseLabel } : {}),
            ...(n.extractorId ? { extractorId: n.extractorId } : {}),
            ...(n.instructions ? { instructions: n.instructions } : {}),
          }));
          const helpers = (def.helpers ?? []).map((h: any) => ({
            name: h.name, description: h.description ?? null, codeChars: (h.code ?? "").length,
          }));
          return result({
            _meta: meta,
            name: def.name, description: def.description, settings: def.settings,
            inputSchema: def.inputSchema, outputSchema: def.outputSchema,
            nodes, edges: def.edges ?? [],
            ...(helpers.length ? { helpers } : {}),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "update_workflow",
      {
        title: "Update workflow settings",
        description:
          "Updates a workflow's name, description, lifecycle status, and API-trigger config — not its graph (use edit_workflow). status: development | preview | active | disabled (activating needs a published version; disabling auto-pauses schedules). AGENT POLICY: keep development while testing; move to preview only when the human should validate; move to active ONLY after explicit user go-live approval. Returns the updated workflow.",
        inputSchema: {
          workflowId: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          status: WorkflowStatus.optional(),
          apiEnabled: z.boolean().optional(),
          apiUrlSlug: z.string().optional(),
        },
        annotations: UPSERT,
      },
      async ({ workflowId, name, description, status, apiEnabled, apiUrlSlug }) => {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (description !== undefined) body.description = description;
        if (status !== undefined) body.status = status;
        if (apiEnabled !== undefined) body.apiEnabled = apiEnabled;
        if (apiUrlSlug !== undefined) body.apiUrlSlug = apiUrlSlug;
        if (Object.keys(body).length === 0)
          return toolFailure(400, "Provide at least one field to update.");
        try {
          const r = await api("PATCH", `/api/agent/workflows/${workflowId}`, { body });
          return result(mapWorkflow(r.workflow));
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "delete_workflow",
      {
        title: "Delete workflow",
        description: "Soft-deletes a workflow (cascades to sessions, schedules, channels). Returns: { success: true }.",
        inputSchema: { workflowId: z.string() },
        annotations: REMOVE,
      },
      async ({ workflowId }) => {
        try {
          const r = await api("DELETE", `/api/agent/workflows/${workflowId}`);
          return result({ success: r.deleted === true, workflowId });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Editing ----
    server.registerTool(
      "edit_workflow",
      {
        title: "Edit workflow",
        description:
          "Applies a composite patch to a workflow's graph and saves a new version. Read the graph first, then send only what changes in `patch`. Best for STRUCTURAL edits (add/remove/rename nodes, rewire edges, settings) — edge remove/update identities include from, to, and handle (omitted handle matches only an unhandled edge). To change part of an existing node's code, prefer edit_node_code (find/replace; no need to resend the whole code string; a nodes.update patch REPLACES each field wholesale). Validated server-side; on success a new version, on failure an error. Pass expectedActiveVersionId (from read_workflow's _meta) to avoid clobbering concurrent edits. Returns: { ok, versionId, versionNumber, deduped } or { error }.",
        inputSchema: {
          workflowId: z.string(),
          patch: WorkflowPatchInput,
          expectedActiveVersionId: z.string().describe("From read_workflow's _meta.versionId.").optional(),
        },
        annotations: CREATE,
      },
      async ({ workflowId, patch, expectedActiveVersionId }) => {
        try {
          const cur = await api("GET", `/api/agent/workflows/${workflowId}`);
          const w = cur.workflow;
          if (!w) return toolFailure(404, "Workflow not found.");
          const current = w.definition;
          if (!current) return toolFailure(400, "Workflow has no version to edit. Create one first.");
          let next: any;
          try {
            next = applyWorkflowPatch(current, patch);
          } catch (patchErr) {
            return toolFailure(
              422,
              patchErr instanceof Error ? patchErr.message : "The workflow patch is invalid.",
              "validation_failed",
            );
          }
          const r = await api("PUT", `/api/agent/workflows/${workflowId}`, {
            body: { definition: next, name: next.name, expectedActiveVersionId: expectedActiveVersionId ?? w.activeVersionId },
          });
          return result({ ok: true, versionId: r.version?.id, versionNumber: r.version?.versionNumber, deduped: r.version?.deduped ?? false });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "edit_node_code",
      {
        title: "Edit node code (find/replace)",
        description:
          "Surgically edits ONE node's code (or instructions / a decision branch expression) by exact string replacement — like a text editor's find & replace. PREFER THIS over edit_workflow when changing part of an existing code block: you send only the changed snippet instead of resending the whole (possibly huge) code string. oldString must match the current text exactly (whitespace included) and occur exactly once, or pass replaceAll. To rewrite a field wholesale or restructure the graph, use edit_workflow. Saves a new version. Returns: { ok, versionId, versionNumber, replacements, fieldChars } or { error }.",
        inputSchema: {
          workflowId: z.string(),
          nodeName: z.string().describe("Exact node name (see read_workflow view:'graph')."),
          oldString: z.string().min(1).describe("Exact text to find in the node's field. Include enough surrounding context to be unique."),
          newString: z.string().describe("Replacement text (may be empty to delete)."),
          field: z
            .enum(["code", "instructions", "expression"])
            .describe("Which node field to edit. Default 'code'. 'expression' searches the legacy expression AND all decision branch expressions.")
            .optional(),
          replaceAll: z.boolean().describe("Replace every occurrence instead of requiring a unique match.").optional(),
          expectedActiveVersionId: z.string().describe("From read_workflow's _meta.versionId.").optional(),
        },
        annotations: CREATE,
      },
      async ({ workflowId, nodeName, oldString, newString, field, replaceAll, expectedActiveVersionId }) => {
        try {
          if (oldString === newString)
            return toolFailure(400, "oldString and newString are identical — nothing to change.");
          const cur = await api("GET", `/api/agent/workflows/${workflowId}`);
          const w = cur.workflow;
          if (!w) return toolFailure(404, "Workflow not found.");
          const current = w.definition;
          if (!current) return toolFailure(400, "Workflow has no version to edit. Create one first.");
          const next = JSON.parse(JSON.stringify(current));
          const node = (next.nodes ?? []).find((n: any) => n.name === nodeName);
          if (!node) {
            const known = (next.nodes ?? []).map((n: any) => n.name).join(", ");
            return toolFailure(404, `No node named "${nodeName}". Nodes: ${known}`);
          }
          const f = field ?? "code";
          // Each target is one string-valued slot the search runs over. 'expression'
          // spans the legacy node.expression plus every branch expression, so a
          // canonical decision node is editable without knowing which shape it uses.
          const targets: { where: string; get: () => unknown; set: (v: string) => void }[] = [];
          if (f === "code") targets.push({ where: "code", get: () => node.code, set: (v) => (node.code = v) });
          if (f === "instructions") targets.push({ where: "instructions", get: () => node.instructions, set: (v) => (node.instructions = v) });
          if (f === "expression") {
            targets.push({ where: "expression", get: () => node.expression, set: (v) => (node.expression = v) });
            (node.branches ?? []).forEach((b: any, i: number) => {
              targets.push({ where: `branches[${i}].expression`, get: () => b.expression, set: (v) => (b.expression = v) });
            });
          }
          const present = targets.filter((t) => typeof t.get() === "string");
          if (!present.length)
            return toolFailure(400, `Node "${nodeName}" (type ${node.type}) has no ${f} to edit.`);
          const counts = present.map((t) => (t.get() as string).split(oldString).length - 1);
          const total = counts.reduce((a, b) => a + b, 0);
          if (total === 0)
            return toolFailure(
              404,
              `oldString not found in ${f} of node "${nodeName}" (${present.map((t) => `${t.where}: ${(t.get() as string).length} chars`).join(", ")}). Read the current text with read_workflow view:'node' and match it exactly, including whitespace.`,
            );
          if (total > 1 && !replaceAll)
            return toolFailure(
              409,
              `oldString occurs ${total} times in ${f} of node "${nodeName}". Add surrounding context to make it unique, or pass replaceAll:true.`,
            );
          present.forEach((t, i) => {
            if (counts[i] > 0) t.set((t.get() as string).split(oldString).join(newString));
          });
          const r = await api("PUT", `/api/agent/workflows/${workflowId}`, {
            body: { definition: next, name: next.name, expectedActiveVersionId: expectedActiveVersionId ?? w.activeVersionId },
          });
          const fieldChars = present.reduce((a, t) => a + (t.get() as string).length, 0);
          return result({
            ok: true,
            versionId: r.version?.id,
            versionNumber: r.version?.versionNumber,
            deduped: r.version?.deduped ?? false,
            replacements: total,
            fieldChars,
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Versions ----
    server.registerTool(
      "list_versions",
      {
        title: "List versions",
        description: "Lists a workflow's saved versions, newest first. Returns: { items: [{ versionId, versionNumber, name, source, createdAt }], nextCursor, activeVersionId }.",
        inputSchema: { workflowId: z.string(), limit, cursor },
        annotations: RO,
      },
      async ({ workflowId, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", `/api/agent/workflows/${workflowId}/versions`, { query: { page, pageSize: lim ?? 25 } });
          const items = (r.versions ?? []).map((v: any) => ({
            versionId: v.id, versionNumber: v.versionNumber, name: v.name ?? null, source: v.source ?? null, createdAt: v.createdAt,
          }));
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "get_version",
      {
        title: "Get version",
        description: "Returns a single saved version including its full definition.",
        inputSchema: { workflowId: z.string(), versionId: z.string() },
        annotations: RO,
      },
      async ({ workflowId, versionId }) => {
        try {
          const r = await api("GET", `/api/agent/workflows/${workflowId}/versions/${versionId}`);
          const v = r.version;
          if (!v) return toolFailure(404, "Version not found.");
          return result({ versionId: v.id, versionNumber: v.versionNumber, name: v.name ?? null, source: v.source ?? null, createdAt: v.createdAt, definition: v.definition });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "revert_to_version",
      {
        title: "Revert to version",
        description: "Reverts a workflow to an earlier version by appending it as a new version.",
        inputSchema: { workflowId: z.string(), versionId: z.string(), expectedActiveVersionId: z.string().optional() },
        annotations: CREATE,
      },
      async ({ workflowId, versionId, expectedActiveVersionId }) => {
        try {
          // The revert endpoint requires the concurrency token; auto-fill it from
          // the current active version when the caller doesn't supply one.
          let expected = expectedActiveVersionId;
          if (!expected) {
            const cur = await api("GET", `/api/agent/workflows/${workflowId}`);
            expected = cur.workflow?.activeVersionId ?? undefined;
          }
          const r = await api("POST", `/api/agent/workflows/${workflowId}/versions/${versionId}/revert`, {
            body: { expectedActiveVersionId: expected },
          });
          return result({ versionId: r.version?.id, versionNumber: r.version?.versionNumber, revertedFromVersionNumber: r.revertedFromVersionNumber });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Schedules ----
    server.registerTool(
      "list_schedules",
      {
        title: "List schedules",
        description: "Lists the schedules attached to a workflow. Returns: { items: [{ scheduleId, name, recurrenceRule, startAt, status, nextFireAt, inputResourceName }] }.",
        inputSchema: { workflowId: z.string() },
        annotations: RO,
      },
      async ({ workflowId }) => {
        try {
          const r = await api("GET", `/api/agent/workflows/${workflowId}/schedules`);
          const items = (r.schedules ?? []).map((s: any) => ({
            scheduleId: s.id, name: s.name ?? null, recurrenceRule: s.recurrenceRule, startAt: s.startAt ?? null,
            status: s.status, nextFireAt: s.nextFireAt ?? null, inputResourceName: s.inputResourceName ?? null,
          }));
          return result({ items });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "create_schedule",
      {
        title: "Create schedule",
        description:
          "Creates a recurring schedule using an RFC 5545 recurrence rule (e.g. 'FREQ=DAILY;BYHOUR=9'). All schedules run in UTC — express times in UTC. Run input comes from a linked project resource (inputResourceName). Set enabled:false to create it paused. A failed pause is reconciled; unknown outcomes return an explicit partialResult. Returns: { scheduleId }.",
        inputSchema: {
          workflowId: z.string(),
          recurrenceRule: z.string().describe("RFC 5545 RRULE, evaluated in UTC."),
          name: z.string().optional(),
          startAt: z.string().describe("ISO 8601 datetime (UTC).").optional(),
          enabled: z.boolean().optional(),
          inputResourceName: z.string().optional(),
        },
        annotations: CREATE,
      },
      async ({ workflowId, recurrenceRule, name, startAt, enabled, inputResourceName }) => {
        try {
          const body: Record<string, unknown> = {
            name: name ?? null,
            recurrenceRule,
            startAt,
            inputResourceName: inputResourceName ?? null,
          };
          const r = await api("POST", `/api/agent/workflows/${workflowId}/schedules`, { body });
          const scheduleId = r.schedule?.id;
          // v1 create derives the initial status from workflow triggerability and
          // ignores a client status, so honor enabled:false with a follow-up pause
          // (ergonomics compose in the MCP, not the CRUD route).
          if (scheduleId && enabled === false && r.schedule?.status !== "paused") {
            try {
              await api("PATCH", `/api/agent/workflows/${workflowId}/schedules/${scheduleId}`, {
                body: { status: "paused" },
              });
            } catch (e) {
              try {
                const current = await findScheduleForReconciliation(workflowId, scheduleId);
                if (current?.status === "paused") {
                  return result({ scheduleId, status: "paused", reconciled: true });
                }
                if (current) {
                  return fail(e, {
                    scheduleId,
                    created: true,
                    previousStatus: r.schedule?.status ?? null,
                    pauseOutcome: "not_applied",
                    currentStatus: current.status ?? null,
                  });
                }
              } catch {
                // Preserve the original pause failure; reconciliation is best effort.
              }
              return fail(e, {
                scheduleId,
                created: true,
                previousStatus: r.schedule?.status ?? null,
                pauseOutcome: "unknown",
                requestedStatus: "paused",
              });
            }
          }
          return result({ scheduleId });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "update_schedule",
      {
        title: "Update schedule",
        description: "Updates a schedule (all schedules run in UTC). Set `enabled` to pause/resume (maps to status active/paused). Returns: { scheduleId }.",
        inputSchema: {
          workflowId: z.string(),
          scheduleId: z.string(),
          recurrenceRule: z.string().describe("RFC 5545 RRULE, evaluated in UTC.").optional(),
          name: z.string().optional(),
          startAt: z.string().describe("ISO 8601 datetime (UTC).").optional(),
          enabled: z.boolean().optional(),
          inputResourceName: z.string().optional(),
        },
        annotations: UPSERT,
      },
      async ({ workflowId, scheduleId, recurrenceRule, name, startAt, enabled, inputResourceName }) => {
        try {
          const body: Record<string, unknown> = {};
          if (name !== undefined) body.name = name;
          if (recurrenceRule !== undefined) body.recurrenceRule = recurrenceRule;
          if (startAt !== undefined) body.startAt = startAt;
          if (inputResourceName !== undefined) body.inputResourceName = inputResourceName;
          if (enabled !== undefined) body.status = enabled ? "active" : "paused";
          const r = await api("PATCH", `/api/agent/workflows/${workflowId}/schedules/${scheduleId}`, { body });
          return result({ scheduleId: r.schedule?.id ?? scheduleId });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "delete_schedule",
      {
        title: "Delete schedule",
        description: "Deletes a schedule from a workflow. Returns: { success: true }.",
        inputSchema: { workflowId: z.string(), scheduleId: z.string() },
        annotations: REMOVE,
      },
      async ({ workflowId, scheduleId }) => {
        try {
          const r = await api("DELETE", `/api/agent/workflows/${workflowId}/schedules/${scheduleId}`);
          return result({ success: r.deleted === true, scheduleId });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Runs ----
    server.registerTool(
      "run_workflow",
      {
        title: "Run workflow",
        description:
          "Triggers a run of the workflow's active version. Defaults to the stable PRODUCTION runtime — omit previewBranch for normal runs. `input` is validated against the workflow's input schema. Some workflows implement a `dryRun` input convention, but the platform does not make arbitrary runs side-effect-free. Returns: { sessionId, status: 'queued' } — poll get_run.",
        inputSchema: {
          workflowId: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
          previewBranch: z
            .string()
            .describe(
              "ADVANCED — leave unset for normal production runs. Set ONLY to run against a specific deployed preview-branch runtime (e.g. testing an unreleased runtime on branch 'pr-123'). The branch MUST have a running preview worker or the run stays stuck in 'queued'."
            )
            .optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ workflowId, input, previewBranch }) => {
        try {
          // Default: no environment/branch → studio resolves its deployment's
          // default Trigger tier (production on a prod studio). Preview is an
          // explicit opt-in: only when the caller names a previewBranch do we
          // send environment='preview' + that branch. A preview run needs a
          // deployed worker for the branch, else it sits in 'queued'.
          const body: Record<string, unknown> = { input: input ?? {} };
          if (previewBranch) {
            body.environment = "preview";
            body.branch = previewBranch;
          }
          const r = await api("POST", `/api/agent/workflows/${workflowId}/run`, { body });
          return result({ sessionId: r.sessionId, status: r.status ?? "queued" });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "list_runs",
      {
        title: "List runs",
        description: "Lists recent runs (sessions), newest first, optionally filtered by workflow and status. Returns: { items: [{ sessionId, workflowId, status, source, startedAt, endedAt, durationMs }], nextCursor }.",
        inputSchema: { workflowId: z.string().optional(), status: RunStatus.optional(), limit, cursor },
        annotations: RO,
      },
      async ({ workflowId, status, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/sessions", {
            query: { workflowId, status, page, pageSize: lim ?? 25 },
          });
          const items = (r.sessions ?? []).map((s: any) => ({
            sessionId: s.id, workflowId: s.workflowId, status: s.status, source: s.source ?? null,
            startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null,
            durationMs: durMs(s.startedAt, s.endedAt),
          }));
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "get_run",
      {
        title: "Get run",
        description:
          "Returns a run's status and result; add `include` for deeper data. include: 'timeline' (per-node status+timing), 'io' (per-node input/output), 'logs' (currently always null — the studio retains no queryable log store; use timeline/io), 'recording' (browser video URL when available). Omit include for a lightweight summary.",
        inputSchema: {
          sessionId: z.string(),
          include: z.array(z.enum(["timeline", "io", "logs", "recording"])).optional(),
          logsCursor: z.string().optional(),
        },
        annotations: RO,
      },
      async ({ sessionId, include, logsCursor }) => {
        try {
          const inc = new Set(include ?? []);
          const r = await api("GET", `/api/agent/sessions/${sessionId}`);
          const s = r.session;
          if (!s) return toolFailure(404, "Run not found.");
          const out: Record<string, unknown> = {
            sessionId: s.id, workflowId: s.workflowId, versionId: s.workflowVersionId ?? null,
            status: s.status, source: s.source ?? null, input: s.inputData ?? null, output: s.outputData ?? null,
            startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null,
            durationMs: durMs(s.startedAt, s.endedAt),
          };
          if (inc.has("timeline") || inc.has("io")) {
            const n = await api("GET", `/api/agent/sessions/${sessionId}/nodes`);
            const nodes = n.nodes ?? [];
            if (inc.has("timeline"))
              out.timeline = nodes.map((nd: any) => ({ name: nd.name, type: nd.type, status: nd.status, startedAt: nd.startedAt, endedAt: nd.endedAt, durationMs: durMs(nd.startedAt, nd.endedAt) }));
            if (inc.has("io"))
              // Drop availableNodeNames from each node's input echo: it repeats the
              // upstream-name list per node (quadratic noise) and the graph already
              // answers "which names can $() see".
              out.nodeIO = nodes.map((nd: any) => {
                const { availableNodeNames: _drop, ...input } = (nd.inputData ?? {}) as Record<string, unknown>;
                return { name: nd.name, input: Object.keys(input).length ? input : null, output: nd.outputData ?? null };
              });
          }
          if (inc.has("recording")) out.recordingUrl = s.recordingUrl ?? null;
          if (inc.has("logs")) {
            // Best-effort: a missing/failing logs endpoint shouldn't fail the whole tool.
            try {
              const lg = await api("GET", `/api/agent/sessions/${sessionId}/logs`, { query: { cursor: logsCursor } });
              out.logs = { entries: lg.logs ?? [], nextCursor: lg.nextCursor ?? null };
            } catch {
              // The studio has no queryable log store by design (the logs
              // endpoint returns an honest 404, not a deployment gap). Per-node
              // execution data lives in the timeline/io includes instead.
              out.logs = null;
              out.logsNote =
                "The studio does not retain queryable execution logs. Use include:['timeline','io'] for the per-node timeline and inputs/outputs.";
            }
          }
          return result(out);
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "cancel_run",
      {
        title: "Cancel run",
        description: "Cancels an in-progress run. Returns: { success: true, status: 'canceled' }.",
        inputSchema: { sessionId: z.string() },
        annotations: UPSERT,
      },
      async ({ sessionId }) => {
        try {
          const r = await api("POST", `/api/agent/sessions/${sessionId}/stop`);
          return result({ success: true, status: r.status ?? "canceled", sessionId });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- HITL ----
    server.registerTool(
      "list_hitl_tasks",
      {
        title: "List human-in-the-loop tasks",
        description: "Lists human-in-the-loop tasks (approvals/inputs that pause a run).",
        inputSchema: {
          sessionId: z.string().uuid().optional(),
          status: z.enum(["pending", "responded", "expired", "canceled"]).optional(),
          limit,
          cursor,
        },
        annotations: RO,
      },
      async ({ sessionId, status, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/hitl/tasks", { query: { sessionId, status, page, pageSize: lim ?? 25 } });
          const items = (r.tasks ?? []).map((t: any) => ({
            taskId: t.id, sessionId: t.sessionId, workflowId: t.workflowId, nodeName: t.nodeName,
            prompt: t.prompt, isApproval: t.isApproval, selectedAction: t.selectedAction,
            status: t.status, createdAt: t.createdAt, expiresAt: t.expiresAt,
            respondedAt: t.respondedAt, respondedByName: t.respondedByName,
          }));
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "complete_hitl_task",
      {
        title: "Complete human-in-the-loop task",
        description: "Submits a human decision to resume a paused run.",
        inputSchema: {
          taskId: z.string().uuid(),
          action: z.string().min(1),
          fields: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
          secretKey: z.string().optional(),
        },
        annotations: CREATE,
      },
      async ({ taskId, action, fields, secretKey }) => {
        try {
          const r = await api("POST", `/api/agent/hitl/tasks/${taskId}/complete`, {
            body: { action, fields, secretKey },
          });
          return result({ success: r.success === true });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Secrets ----
    server.registerTool(
      "list_secrets",
      {
        title: "List secrets",
        description: "Lists the Doppler config's secret NAMES (values are never returned). Returns: { items: [{ key }], dopplerConfigured, nextCursor }.",
        inputSchema: { dopplerProject: dopplerProjectInput, dopplerConfig: dopplerConfigInput, limit, cursor },
        annotations: RO,
      },
      async ({ dopplerProject, dopplerConfig, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/secrets", { query: { ...dopplerQuery(dopplerProject, dopplerConfig), page, pageSize: lim ?? 25 } });
          const items = (r.secrets ?? []).map((name: string) => ({ key: name }));
          return result({ items, dopplerConfigured: r.dopplerConfigured !== false, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "set_secrets",
      {
        title: "Set secrets",
        description:
          "Creates or updates one or more project secrets (upsert by key). Values are write-only. A failed current write reports attemptedKey + outcome:'unknown'; updated contains only prior acknowledgements. Returns: { updated: [keys] }.",
        inputSchema: {
          secrets: z.array(z.object({ key: z.string(), value: z.string() })).min(1),
          dopplerProject: dopplerProjectInput,
          dopplerConfig: dopplerConfigInput,
        },
        annotations: UPSERT,
      },
      async ({ secrets, dopplerProject, dopplerConfig }) => {
        const updated: string[] = [];
        try {
          const query = dopplerQuery(dopplerProject, dopplerConfig);
          for (const [index, s] of secrets.entries()) {
            // Name-keyed upsert — PUT creates or updates; the value is write-only.
            try {
              await api("PUT", `/api/agent/secrets/${encodeURIComponent(s.key)}`, {
                query,
                body: { value: s.value },
              });
            } catch (e) {
              return fail(e, {
                updated,
                attemptedKey: s.key,
                outcome: "unknown",
                remainingKeys: secrets.slice(index + 1).map((entry) => entry.key),
              });
            }
            updated.push(s.key);
          }
          return result({ updated });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "delete_secret",
      {
        title: "Delete secret",
        description: "Deletes a project secret by key. Returns: { success: true }.",
        inputSchema: { key: z.string(), dopplerProject: dopplerProjectInput, dopplerConfig: dopplerConfigInput },
        annotations: REMOVE,
      },
      async ({ key, dopplerProject, dopplerConfig }) => {
        try {
          await api("DELETE", `/api/agent/secrets/${encodeURIComponent(key)}`, { query: dopplerQuery(dopplerProject, dopplerConfig) });
          return result({ success: true, key });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Resources ----
    server.registerTool(
      "list_resources",
      {
        title: "List resources",
        description:
          "Lists project data resources in the PAT environment control plane. Data resources only; project files are separate. API/workflow sources may overwrite values automatically. Search uses bounded complete-page scanning. Returns the normalized full resource shape; prefer resourceId for later mutations.",
        inputSchema: { lifecycle: Lifecycle.optional(), search: z.string().optional(), limit, cursor },
        annotations: RO,
      },
      async ({ lifecycle, search, limit: lim, cursor: cur }) => {
        try {
          if (search) {
            const filtered = await listFilteredResources({
              search,
              lifecycle,
              limit: lim ?? 25,
              cursor: cur,
            });
            return result({
              items: filtered.items.map(mapResource),
              nextCursor: filtered.nextCursor,
              truncated: filtered.truncated,
            });
          }
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/resources", { query: { lifecycle, page, pageSize: lim ?? 25 } });
          const items = (r.resources ?? []).map(mapResource);
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "get_resource",
      {
        title: "Get resource",
        description:
          "Returns one normalized project data resource. Data resources only; files are separate. Prefer resourceId. Name + lifecycle is a bounded convenience lookup that can race concurrent changes; ambiguous name-only lookup conflicts.",
        inputSchema: ResourceIdentifierInput,
        annotations: RO,
      },
      async ({ resourceId, name, lifecycle }) => {
        try {
          if (!resourceId && !name) return toolFailure(400, "Provide resourceId or name.");
          const response = resourceId
            ? await api("GET", `/api/agent/resources/${resourceId}`)
            : { resource: await findResource(name as string, lifecycle) };
          const x = response.resource;
          if (!x) {
            return toolFailure(
              404,
              `No resource matched ${resourceId ?? (lifecycle ? `${name}/${lifecycle}` : name)}.`,
            );
          }
          return result(mapResource(x));
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "set_resource",
      {
        title: "Set resource",
        description:
          "Creates or updates project data resources through the PAT environment control plane. source defaults to manual on create; api requires config and workflow/api values may later be overwritten automatically. Prefer resourceId. Name/lifecycle upsert remains a bounded, potentially racy convenience. Updates never move lifecycle.",
        inputSchema: {
          resourceId: z.string().uuid().optional(),
          name: z.string().min(1).optional(),
          value: z.unknown(),
          description: z.string().max(500).nullable().optional(),
          lifecycle: Lifecycle.optional(),
          source: ResourceSource.optional(),
          config: ResourceApiConfig.optional(),
        },
        annotations: UPSERT,
      },
      async ({ resourceId, name, value, description, lifecycle, source, config }) => {
        try {
          const updateBody = {
            value,
            ...(description !== undefined ? { description } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(config !== undefined ? { config } : {}),
          };
          if (resourceId) {
            const updated = await api("PUT", `/api/agent/resources/${resourceId}`, {
              body: updateBody,
            });
            return result({ resource: expectResource(updated) });
          }
          if (!name) return toolFailure(400, "Provide resourceId or name.");
          if (lifecycle) {
            const existing = await findResource(name, lifecycle);
            if (existing) {
              const updated = await api("PUT", `/api/agent/resources/${existing.id}`, {
                body: updateBody,
              });
              return result({ resource: expectResource(updated) });
            }
          } else {
            const existing = await findResources(name);
            if (existing.length > 1) {
              return toolFailure(
                409,
                `Resource name "${name}" exists in multiple lifecycles; provide lifecycle or resourceId.`,
              );
            }
            if (existing.length === 1) {
              const updated = await api("PUT", `/api/agent/resources/${existing[0].id}`, {
                body: updateBody,
              });
              return result({ resource: expectResource(updated) });
            }
          }
          const created = await api("POST", "/api/agent/resources", {
            body: {
              name,
              value,
              source: source ?? "manual",
              ...(description !== undefined ? { description } : {}),
              ...(lifecycle !== undefined ? { lifecycle } : {}),
              ...(config !== undefined ? { config } : {}),
            },
          });
          return result({ resources: expectResources(created) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "delete_resource",
      {
        title: "Delete resource",
        description:
          "Deletes one manual, API, or workflow project data resource. Data resources only; files are separate. Prefer resourceId. Name + lifecycle is a bounded, potentially racy convenience lookup; ambiguous name-only lookup conflicts.",
        inputSchema: ResourceIdentifierInput,
        annotations: REMOVE,
      },
      async ({ resourceId, name, lifecycle }) => {
        try {
          if (!resourceId && !name) return toolFailure(400, "Provide resourceId or name.");
          const targetId = resourceId ?? (await findResource(name as string, lifecycle))?.id;
          if (!targetId) {
            return toolFailure(404, `No resource matched ${lifecycle ? `${name}/${lifecycle}` : name}.`);
          }
          await api("DELETE", `/api/agent/resources/${targetId}`);
          return result({ success: true, resourceId: targetId });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "test_resource_api",
      {
        title: "Test resource API",
        description:
          "Fetches and parses an external API URL using Studio's resource fetch rules. Read-only and does not persist or modify a resource. Returns: { value }.",
        inputSchema: { url: z.string().url() },
        annotations: EXTERNAL_READ,
      },
      async ({ url }) => {
        try {
          const response = await api("POST", "/api/agent/resources/test-fetch", { body: { url } });
          return result({ value: response.value });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Extractors ----
    server.registerTool(
      "list_extractors",
      {
        title: "List extractors",
        description: "Lists the document extractors available in the project (for document nodes).",
        inputSchema: { search: z.string().optional(), limit, cursor },
        annotations: RO,
      },
      async ({ search, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/extractors", { query: { search, page, pageSize: lim ?? 25 } });
          const items = (r.extractors ?? []).map((x: any) => ({
            extractorId: x.id, name: x.name, activeVersionId: x.activeVersionId ?? null, description: x.description ?? null,
          }));
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "get_extractor",
      {
        title: "Get extractor",
        description: "Returns a document extractor.",
        inputSchema: { extractorId: z.string(), view: z.enum(["summary", "full"]).optional() },
        annotations: RO,
      },
      async ({ extractorId, view }) => {
        try {
          const r = await api("GET", `/api/agent/extractors/${extractorId}`, { query: { view } });
          return result({ extractor: r.extractor ?? r });
        } catch (e) {
          return fail(e);
        }
      },
    );
  },
  {
    serverInfo: { name: "automat-robotic-workflows", version: packageJson.version },
    instructions:
      "Build, run, and manage Automat RPA workflows in one project. Authenticate with a Studio personal access token (pat_…). Select the target project FIRST. Precedence is project_id query → x-project-id header → remembered set_project → STUDIO_DEFAULT_PROJECT_ID. Explicit project_id/x-project-id is safest. Remembered selection is isolated by PAT + logical connector when connection_id, x-connection-id, or a client-supplied mcp-session-id is present. Only connector-less callers use the compatibility PAT-wide bucket, so all bare callers sharing that PAT share one remembered selection; give each bare connector a unique PAT to prevent collisions. Token tiers: read tokens can list/inspect most domains (but not read definition JSON — read_workflow 'full'/'node' need an authorship-tier PAT; 'graph' always works); write tokens can also run workflows, stop sessions, and complete HITL tasks; workflow/schedule mutations need authorship; list_versions, list_secrets, secret set/delete, and every resource control-plane operation (list, get, test, create, update, delete) need authorship (author role + write token).\n\n" +
      "Build loop: call get_docs FIRST to learn how to write nodes (code-block globals, $('NodeName'), fetch, examples), get_workflow_schema for the exact JSON shape, read_workflow(view:'graph') to see the current graph, then edit: edit_node_code for surgical find/replace inside one node's code (preferred for code changes — no resending big strings), edit_workflow with a small patch for structural changes (both validate and save a version; fix any returned error and retry). Run with run_workflow and inspect with get_run(include:['timeline','io']).\n\n" +
      "Lifecycle policy (REQUIRED): development while the agent iterates (default for new workflows; use dryRun:true only when the workflow explicitly implements that convention, because the platform does not suppress arbitrary side effects) → preview ONLY when ready for the human to test → active ONLY after explicit user go-live approval. Never skip to active on your own. get_docs topic:'lifecycle' has the full ladder.\n\n" +
      "Model: each edit saves an immutable version; lifecycle is development → preview → active → disabled (update_workflow; activating needs a published version). Schedules use RFC 5545 rules (UTC) and a linked project resource for input. Secrets are write-only. document nodes reference an extractorId (list_extractors).",
  },
  { basePath: "/api", maxDuration: 60, verboseLogs: true },
);

// ---------------------------------------------------------------------------
// Auth-wrapped handler exports
// ---------------------------------------------------------------------------
const authed = async (req: Request): Promise<Response> => {
  const key = extractKey(req);
  if (!key) {
    return new Response(JSON.stringify({ error: "unauthorized", message: "Missing API key" }), {
      status: 401,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  }
  const projectId = extractProjectId(req);
  const connectionId = extractConnectionId(req);
  let response: Response;
  try {
    response = await callerKey.run(key, () =>
      connectionId
        ? callerConnection.run(connectionId, () =>
            projectId ? callerProject.run(projectId, () => baseHandler(req)) : baseHandler(req),
          )
        : projectId
          ? callerProject.run(projectId, () => baseHandler(req))
          : baseHandler(req),
    );
  } catch {
    response = new Response(JSON.stringify({ error: "internal_error", message: "MCP request failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  for (const [name, value] of Object.entries(corsHeaders)) {
    response.headers.set(name, value);
  }
  return response;
};

const handleOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export { authed as GET, authed as POST, authed as DELETE, handleOptions as OPTIONS };

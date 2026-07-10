import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";

/**
 * Automat Robotic Workflows MCP Server.
 *
 * Stateless Streamable-HTTP endpoint (plain Vercel Function). Each tool forwards
 * to the studio public v1 API under /api/v1/projects/{projectId}/..., authenticating
 * with a Personal Access Token (pat_...) that acts as its owning user.
 *
 * Because a PAT spans every project its user can access, the target project can
 * no longer be resolved from the credential — it is CONNECTION-scoped: pass
 * `?project_id=<uuid>` on the MCP URL (or the `x-project-id` header, or set
 * STUDIO_DEFAULT_PROJECT_ID on the server). To work across multiple projects,
 * register the connector once per project.
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
// longer implies one). Resolved per request: ?project_id= → x-project-id header
// → STUDIO_DEFAULT_PROJECT_ID env.
const callerProject = new AsyncLocalStorage<string>();
const STUDIO_DEFAULT_PROJECT_ID = process.env.STUDIO_DEFAULT_PROJECT_ID || undefined;

// set_project state: the agent-selected project, persisted in Upstash Redis
// keyed by a hash of the caller's token. The server is a stateless, multi-
// instance serverless function, so an in-process value can't survive across
// requests — the shared store is what lets `set_project` stick between calls
// and across cold starts. Precedence: set_project (this store) > ?project_id=
// connection param / x-project-id header > STUDIO_DEFAULT_PROJECT_ID.
//
// Falls back to an in-process Map when Redis env is absent (local dev / tests /
// a single stdio process) — there the Map genuinely persists for the process.
const REMEMBERED_PROJECT_TTL_S = 6 * 60 * 60; // 6h
const projectKey = (bucket: string) => `pat:project:${bucket}`;

const redis =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
    : null;
const memFallback = new Map<string, { projectId: string; at: number }>();

function tokenBucket(): string | null {
  const key = callerKey.getStore();
  return key ? createHash("sha256").update(key).digest("hex") : null;
}

async function rememberedProjectId(): Promise<string | undefined> {
  const bucket = tokenBucket();
  if (!bucket) return undefined;
  if (redis) {
    // Best-effort read: a Redis blip must never break auth — treat as "no
    // remembered project", which self-heals via a set_project re-run.
    try {
      return (await redis.get<string>(projectKey(bucket))) ?? undefined;
    } catch {
      return undefined;
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

async function rememberProject(projectId: string): Promise<void> {
  const bucket = tokenBucket();
  if (!bucket) return;
  if (redis) {
    await redis.set(projectKey(bucket), projectId, { ex: REMEMBERED_PROJECT_TTL_S });
    return;
  }
  if (memFallback.size >= 1000) memFallback.clear();
  memFallback.set(bucket, { projectId, at: Date.now() });
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, authorization, x-api-key, mcp-session-id, mcp-protocol-version",
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
  return (
    new URL(req.url).searchParams.get("project_id") ??
    req.headers.get("x-project-id") ??
    STUDIO_DEFAULT_PROJECT_ID ??
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

interface ApiOpts {
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

async function api(method: string, path: string, opts: ApiOpts = {}): Promise<any> {
  if (!STUDIO_API_BASE_URL) throw new ApiError(500, "config_error", "STUDIO_API_BASE_URL is not set on the MCP server.");
  const key = callerKey.getStore();
  if (!key) throw new ApiError(401, "unauthorized", "Missing API key.");

  // Single choke point for the /api/agent → /api/v1 repoint: every tool still
  // names the legacy /api/agent/* path; it is rewritten here onto the PAT
  // surface. `/api/agent/schema` is the one project-agnostic endpoint.
  let resolvedPath = path;
  if (path.startsWith("/api/agent/")) {
    if (path === "/api/agent/schema") {
      resolvedPath = "/api/v1/schema";
    } else if (path === "/api/agent/projects") {
      // Project DISCOVERY — the one list that exists to find a projectId,
      // so it must not require one.
      resolvedPath = "/api/v1/projects";
    } else {
      const projectId = (await rememberedProjectId()) ?? callerProject.getStore();
      if (!projectId) {
        throw new ApiError(
          400,
          "config_error",
          "Missing project id — call the set_project tool with the project UUID (preferred), or add ?project_id=<uuid> to the MCP URL / an x-project-id header / STUDIO_DEFAULT_PROJECT_ID."
        );
      }
      resolvedPath = `/api/v1/projects/${projectId}/` + path.slice("/api/agent/".length);
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
  let data: any = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const apiCode = (data && data.error) || `http_${res.status}`;
    const message = (data && (data.message || data.error)) || text || res.statusText;
    throw new ApiError(res.status, String(apiCode), String(message), data && data.issues);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Result + error helpers (MCP tool result shape)
// ---------------------------------------------------------------------------
const result = (data: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

function ourCode(status: number): string {
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

function fail(e: unknown) {
  if (e instanceof ApiError) {
    return result({
      error: {
        code: ourCode(e.status),
        status: e.status,
        message: e.message,
        ...(e.issues ? { issues: e.issues } : {}),
      },
    });
  }
  return result({ error: { code: "internal_error", message: e instanceof Error ? e.message : String(e) } });
}

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

function applyEdgeOps(next: any, ops: any) {
  if (ops.remove?.length) {
    next.edges = (next.edges ?? []).filter(
      (e: any) => !ops.remove.some((t: any) => t.from === e.from && t.to === e.to),
    );
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

function applyWorkflowPatch(current: any, patch: any): any {
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
const Environment = z.enum(["development", "staging", "production"]);
const Lifecycle = z.enum(["development", "preview", "active"]);
// Shared, concise execution model — folded into the definition/patch param
// descriptions so an agent can author nodes without a separate get_workflow_schema
// call (which remains the full reference). Kept tight to respect the ~2KB budget.
const CODE_MODEL =
  "Node types: start, end, block, decision, document, hitl. A `block` is deterministic `code` (mode:'code', the default — no LLM tokens) or AI `execute` (mode:'execute' — costs tokens; prefer code). Block code runs async (await + TypeScript) and must `return` a value; in-scope globals: `page` & `context` (Playwright), `$('NodeName')` (a prior node's return), `secrets`, `helpers`, `projectResources`, `logger`. A `decision` routes by ordered boolean `branches:[{id,label?,expression}]` (same globals; first true wins) — one outgoing edge per branch with `handle:<branch id>` plus one `handle:'else'` edge for no-match. Browser recording: settings.browser={headless:false,recording:true}.";
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
        "helpers.<name> are shared functions defined in the definition's top-level `helpers:[{name,description?,code}]` array (read them via read_workflow view:'full'; graph view lists their names). projectResources.<name> are named project data resources.",
      logger: "logger.info(msg) / logger.error(msg).",
      "emit, state": "emit(title,event,data) for events; state.sessions.previous / state.artifacts for cross-run state.",
    },
  },
  nodeTypes: {
    start: "Entry point (exactly one).",
    end: "Exit point; passes through the previous node's output.",
    block: "Runs code (mode:'code') or an AI agent (mode:'execute' — costs tokens; prefer code). Fields: name, position, mode, code | (instructions + execute).",
    decision:
      "Ordered `branches:[{id, label?, expression}]` — each expression is a JS boolean (same scope as code); the first true branch wins. Route one outgoing edge per branch with handle=<branch id>, plus exactly one catch-all edge with handle:'else' (label it via the node's `elseLabel`). Branch ids are stable routing keys — never 'else', never renamed when the label changes. (Legacy binary form — a single `expression` with edges handle:'true'/'false' — still runs but is deprecated; author `branches`.)",
    document: "Extract data from files via an extractor (extractorId + fileInputs). Find ids with list_extractors.",
    hitl: "Pause for a human: prompt + actions:[{id,label}]. Outgoing edges route by action id or 'timeout'.",
  },
  browser:
    "Set settings.browser = { headless:false, recording:true } to capture a recording (get_run include:['recording']). `page` is Playwright. Tip: a native post-login dialog (e.g. a 'breached password' bubble) can swallow real input clicks and stall navigation — if so, click in-page: await page.evaluate(() => document.querySelector(sel).click()).",
  secrets:
    "Store with set_secrets({secrets:[{key,value}]}); read at runtime as secrets.KEY inside a code block. list_secrets never returns values.",
  schedules:
    "create_schedule with an RFC 5545 recurrenceRule (e.g. 'FREQ=DAILY;BYHOUR=9'), evaluated in UTC. Run input comes from a linked project resource (inputResourceName).",
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
const DOCS_TOPICS = ["overview", "codeNodes", "nodeTypes", "browser", "secrets", "schedules", "examples"] as const;

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
        remove: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .optional(),
  })
  .passthrough()
  .describe(
    `Composite patch — send only what changes: { nodes:{add[],update[{name,patch}],remove[]}, edges:{add[],remove[]}, ...top-level } (settings deep-merges; others replace). Applied: nodes.remove → add → update → edges.remove → add → top-level. ${CODE_MODEL} ${CODE_EXAMPLE}`,
  );
const limit = z.number().int().min(1).max(100).describe("Page size (default 25, max 100).").optional();
const cursor = z.string().describe("Pagination cursor from a previous response's nextCursor.").optional();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
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

// Resolve a secret/resource id by name (the v1 API addresses these by id).
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
async function findResource(name: string, lifecycle?: string): Promise<any | null> {
  const r = await api("GET", "/api/agent/resources", { query: { name, lifecycle, pageSize: 1 } });
  return r.resources?.[0] ?? null;
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
          "Lists the projects this token can access (id + name), for picking a set_project target. Allowlist-scoped tokens see only their allowlisted projects. Returns: { items: [{ projectId, name }], nextCursor }.",
        inputSchema: { limit, cursor },
        annotations: RO,
      },
      async ({ limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/projects", { query: { page, pageSize: lim ?? 25 } });
          const items = (r.projects ?? []).map((p: any) => ({ projectId: p.id, name: p.name }));
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
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
          "Sets the target Studio project for every subsequent tool call (a PAT spans all your projects, so one must be selected). Validates access with a lightweight probe before storing. Call this FIRST if tools error with 'Missing project id', and to switch projects mid-session. The selection is remembered server-side best-effort — if it is ever forgotten (cold start), calls error with 'Missing project id' again: just re-run set_project. Returns: { projectId, validated: true }.",
        inputSchema: {
          projectId: z.string().uuid().describe("The Studio project UUID — discover it with list_projects."),
        },
        annotations: UPSERT,
      },
      async ({ projectId }) => {
        try {
          const bucket = tokenBucket();
          if (!bucket) throw new ApiError(401, "unauthorized", "Missing API key.");
          // Validate against the DISCOVERY listing (an all-projects token gets
          // an empty-but-200 workflows list even for a nonexistent project id,
          // so probing a project-scoped route can't tell a typo from an empty
          // project). Walk the pages until the id shows up.
          let found = false;
          for (let page = 1; page <= 20 && !found; page++) {
            const r = await api("GET", "/api/agent/projects", { query: { page, pageSize: 100 } });
            found = (r.projects ?? []).some((p: any) => p.id === projectId);
            if (page >= (r.totalPages ?? 1)) break;
          }
          if (!found) {
            return result({
              error: { code: "not_found", message: `Project ${projectId} is not accessible to this token — call list_projects to see the available projects.` },
            });
          }
          await rememberProject(projectId);
          return result({ projectId, validated: true });
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
          note: "Runtime version selection is not exposed by the API; the schema/create endpoints use the deployment default.",
        }),
    );

    server.registerTool(
      "get_docs",
      {
        title: "Get authoring docs",
        description:
          "How to author Automat workflows: code-node globals ($('NodeName'), fetch, secrets), async/return semantics, node types, browser/recording, schedules, and worked examples. CALL THIS FIRST when building or editing a workflow. Pass `topic` to return just one section.",
        inputSchema: {
          topic: z
            .enum(["overview", "codeNodes", "nodeTypes", "browser", "secrets", "schedules", "examples"])
            .describe("Optional: return only this section.")
            .optional(),
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
          "Returns the workflow definition JSON Schema (exact field shapes for nodes, edges, settings). Returns: { runtimeVersion, jsonSchema }.",
        inputSchema: { runtimeVersion: z.string().describe("Defaults to 'latest'.").optional() },
        annotations: RO,
      },
      async ({ runtimeVersion }) => {
        try {
          const r = await api("GET", "/api/agent/schema");
          return result({ runtimeVersion: runtimeVersion ?? "latest", jsonSchema: r.schema });
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
          const r = await api("GET", "/api/agent/workflows", { query: { page, pageSize: lim ?? 25 } });
          let items = (r.workflows ?? []).map(mapWorkflow);
          if (status) items = items.filter((w: any) => w.status === status);
          if (search) {
            const q = search.toLowerCase();
            items = items.filter((w: any) => (w.name ?? "").toLowerCase().includes(q) || (w.description ?? "").toLowerCase().includes(q));
          }
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
          "Creates a new workflow and its first version. Omit `definition` for a minimal start → end scaffold. Returns: { workflowId, versionId, versionNumber, status }.",
        inputSchema: {
          name: z.string(),
          description: z.string().optional(),
          definition: DefinitionInput.optional(),
          runtimeVersion: z.string().describe("Defaults to 'latest'.").optional(),
        },
        annotations: CREATE,
      },
      async ({ name, definition }) => {
        try {
          const def = definition ?? MIN_DEFINITION(name);
          const r = await api("POST", "/api/agent/workflows", { body: { definition: def, name } });
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
          if (!def) return result({ error: { code: "not_found", message: "Source workflow has no active version to copy." } });
          const newName = name ?? `Copy of ${src.workflow?.name ?? "workflow"}`;
          const created = { ...def, name: newName };
          const r = await api("POST", "/api/agent/workflows", { body: { definition: created, name: newName } });
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
            return result({ error: { code: "bad_request", message: "nodeName is required when view='node'." } });
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
              if (!lw) return result({ error: { code: "not_found", message: "Workflow not found." } });
              return result({
                _meta: metaOf(lw),
                ...(lw.graph ?? {}),
                note: "Lean graph (node names/types + edges): this token has no authorship tier, so the definition-derived fields (positions, expressions, schemas, settings) are unavailable.",
              });
            }
            throw e;
          }
          const w = r.workflow;
          if (!w) return result({ error: { code: "not_found", message: "Workflow not found." } });
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
          "Updates a workflow's name, description, lifecycle status, and API-trigger config — not its graph (use edit_workflow). status: development | preview | active | disabled (activating needs a published version; disabling auto-pauses schedules). Returns the updated workflow.",
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
          return result({ error: { code: "bad_request", message: "Provide at least one field to update." } });
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
          "Applies a composite patch to a workflow's graph and saves a new version. Read the graph first, then send only what changes in `patch`. Best for STRUCTURAL edits (add/remove/rename nodes, rewire edges, settings) — to change part of an existing node's code, prefer edit_node_code (find/replace; no need to resend the whole code string; a nodes.update patch REPLACES each field wholesale). Validated server-side; on success a new version, on failure an error. Pass expectedActiveVersionId (from read_workflow's _meta) to avoid clobbering concurrent edits. Returns: { ok, versionId, versionNumber, deduped } or { error }.",
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
          if (!w) return result({ error: { code: "not_found", message: "Workflow not found." } });
          const current = w.definition;
          if (!current) return result({ error: { code: "bad_request", message: "Workflow has no version to edit. Create one first." } });
          let next: any;
          try {
            next = applyWorkflowPatch(current, patch);
          } catch (patchErr) {
            return result({ error: { code: "validation_failed", message: patchErr instanceof Error ? patchErr.message : String(patchErr) } });
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
            return result({ error: { code: "bad_request", message: "oldString and newString are identical — nothing to change." } });
          const cur = await api("GET", `/api/agent/workflows/${workflowId}`);
          const w = cur.workflow;
          if (!w) return result({ error: { code: "not_found", message: "Workflow not found." } });
          const current = w.definition;
          if (!current) return result({ error: { code: "bad_request", message: "Workflow has no version to edit. Create one first." } });
          const next = JSON.parse(JSON.stringify(current));
          const node = (next.nodes ?? []).find((n: any) => n.name === nodeName);
          if (!node) {
            const known = (next.nodes ?? []).map((n: any) => n.name).join(", ");
            return result({ error: { code: "not_found", message: `No node named "${nodeName}". Nodes: ${known}` } });
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
            (node.branches ?? []).forEach((b: any, i: number) =>
              targets.push({ where: `branches[${i}].expression`, get: () => b.expression, set: (v) => (b.expression = v) }),
            );
          }
          const present = targets.filter((t) => typeof t.get() === "string");
          if (!present.length)
            return result({ error: { code: "bad_request", message: `Node "${nodeName}" (type ${node.type}) has no ${f} to edit.` } });
          const counts = present.map((t) => (t.get() as string).split(oldString).length - 1);
          const total = counts.reduce((a, b) => a + b, 0);
          if (total === 0)
            return result({
              error: {
                code: "not_found",
                message: `oldString not found in ${f} of node "${nodeName}" (${present.map((t) => `${t.where}: ${(t.get() as string).length} chars`).join(", ")}). Read the current text with read_workflow view:'node' and match it exactly, including whitespace.`,
              },
            });
          if (total > 1 && !replaceAll)
            return result({
              error: {
                code: "conflict",
                message: `oldString occurs ${total} times in ${f} of node "${nodeName}". Add surrounding context to make it unique, or pass replaceAll:true.`,
              },
            });
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
          if (!v) return result({ error: { code: "not_found", message: "Version not found." } });
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
          "Creates a recurring schedule using an RFC 5545 recurrence rule (e.g. 'FREQ=DAILY;BYHOUR=9'). All schedules run in UTC — express times in UTC. Run input comes from a linked project resource (inputResourceName). Set enabled:false to create it paused. Returns: { scheduleId }.",
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
            await api("PATCH", `/api/agent/workflows/${workflowId}/schedules/${scheduleId}`, { body: { status: "paused" } });
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
          "Triggers a run of the workflow's active version on the stable production runtime (the default for all automations). `input` is validated against the workflow's input schema. Returns: { sessionId, status: 'queued' } — poll get_run.",
        inputSchema: {
          workflowId: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ workflowId, input }) => {
        try {
          // No environment/branch sent: studio resolves the default Trigger
          // deploy tier for its deployment (production on a prod studio). The
          // preview tier is deliberately NOT agent-selectable — a preview run
          // needs a pinned preview-branch worker, which otherwise leaves the
          // run stuck in `queued`.
          const r = await api("POST", `/api/agent/workflows/${workflowId}/run`, { body: { input: input ?? {} } });
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
          const r = await api("GET", "/api/agent/sessions", { query: { workflowId, page, pageSize: lim ?? 25 } });
          let items = (r.sessions ?? []).map((s: any) => ({
            sessionId: s.id, workflowId: s.workflowId, status: s.status, source: s.source ?? null,
            startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null,
            durationMs: durMs(s.startedAt, s.endedAt),
          }));
          if (status) items = items.filter((s: any) => s.status === status);
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
          if (!s) return result({ error: { code: "not_found", message: "Run not found." } });
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

    // ---- HITL (not in v1 API yet) ----
    server.registerTool(
      "list_hitl_tasks",
      {
        title: "List human-in-the-loop tasks",
        description: "Lists human-in-the-loop tasks (approvals/inputs that pause a run).",
        inputSchema: { sessionId: z.string().optional(), status: z.enum(["pending", "completed", "expired"]).optional(), limit, cursor },
        annotations: RO,
      },
      async ({ sessionId, status, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/hitl/tasks", { query: { sessionId, status, page, pageSize: lim ?? 25 } });
          const items = (r.tasks ?? []).map((t: any) => ({
            taskId: t.id, sessionId: t.sessionId, workflowId: t.workflowId, nodeName: t.nodeName,
            prompt: t.prompt, actions: t.actions, isApproval: t.isApproval, fields: t.fields,
            status: t.status, createdAt: t.createdAt, expiresAt: t.expiresAt,
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
        inputSchema: { taskId: z.string(), action: z.string(), fields: z.record(z.string(), z.unknown()).optional() },
        annotations: CREATE,
      },
      async ({ taskId, action, fields }) => {
        try {
          const r = await api("POST", `/api/agent/hitl/tasks/${taskId}/complete`, { body: { action, fields } });
          return result({ success: r.success ?? true });
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
        description: "Creates or updates one or more project secrets (upsert by key). Values are write-only. Returns: { updated: [keys] }.",
        inputSchema: {
          secrets: z.array(z.object({ key: z.string(), value: z.string() })).min(1),
          dopplerProject: dopplerProjectInput,
          dopplerConfig: dopplerConfigInput,
        },
        annotations: UPSERT,
      },
      async ({ secrets, dopplerProject, dopplerConfig }) => {
        try {
          const query = dopplerQuery(dopplerProject, dopplerConfig);
          const updated: string[] = [];
          for (const s of secrets) {
            // Name-keyed upsert — PUT creates or updates; the value is write-only.
            await api("PUT", `/api/agent/secrets/${encodeURIComponent(s.key)}`, { query, body: { value: s.value } });
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
        description: "Lists project data resources by name and metadata. Returns: { items: [{ name, kind, description, lifecycle, updatedAt }], nextCursor }.",
        inputSchema: { lifecycle: Lifecycle.optional(), search: z.string().optional(), limit, cursor },
        annotations: RO,
      },
      async ({ lifecycle, search, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/agent/resources", { query: { lifecycle, page, pageSize: lim ?? 25 } });
          let items = (r.resources ?? []).map((x: any) => ({ name: x.name, kind: "data", description: x.description ?? null, lifecycle: x.lifecycle ?? null, updatedAt: x.updatedAt }));
          if (search) { const q = search.toLowerCase(); items = items.filter((x: any) => (x.name ?? "").toLowerCase().includes(q)); }
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
        description: "Returns a project data resource by name (includes its value).",
        inputSchema: { name: z.string(), lifecycle: Lifecycle.optional() },
        annotations: RO,
      },
      async ({ name, lifecycle }) => {
        try {
          const x = await findResource(name, lifecycle);
          if (!x) return result({ error: { code: "not_found", message: `No resource named "${name}".` } });
          return result({ name: x.name, kind: "data", value: x.value, description: x.description ?? null, lifecycle: x.lifecycle ?? null, updatedAt: x.updatedAt });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "set_resource",
      {
        title: "Set resource",
        description: "Creates or updates a data (JSON) resource by name (upsert). Omitting lifecycle on create seeds all stages. Returns: { name }.",
        inputSchema: { name: z.string(), value: z.unknown(), description: z.string().optional(), lifecycle: Lifecycle.optional() },
        annotations: UPSERT,
      },
      async ({ name, value, description, lifecycle }) => {
        try {
          const existing = await findResource(name, lifecycle);
          if (existing) await api("PUT", `/api/agent/resources/${existing.id}`, { body: { value, description } });
          else await api("POST", "/api/agent/resources", { body: { name, value, description, lifecycle } });
          return result({ name });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "delete_resource",
      {
        title: "Delete resource",
        description: "Deletes a project data resource by name. Returns: { success: true }.",
        inputSchema: { name: z.string(), lifecycle: Lifecycle.optional() },
        annotations: REMOVE,
      },
      async ({ name, lifecycle }) => {
        try {
          const x = await findResource(name, lifecycle);
          if (!x) return result({ error: { code: "not_found", message: `No resource named "${name}".` } });
          await api("DELETE", `/api/agent/resources/${x.id}`);
          return result({ success: true, name });
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- Extractors (not in v1 API yet) ----
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
    serverInfo: { name: "automat-robotic-workflows", version: "0.4.0" },
    instructions:
      "Build, run, and manage Automat RPA workflows in one project. Authenticate with a Studio personal access token (pat_…). Select the target project FIRST: list_projects to discover ids, then set_project (re-call it if a tool errors with 'Missing project id') — or pin one on the connection via ?project_id=<uuid> / x-project-id / STUDIO_DEFAULT_PROJECT_ID. Token tiers: read tokens can list/inspect (but not read definition JSON — read_workflow 'full'/'node' need an authorship-tier PAT; 'graph' always works); write tokens can also run workflows, stop sessions, and complete HITL tasks; workflow/schedule/secret/resource mutations need authorship (author role + write token).\n\n" +
      "Build loop: call get_docs FIRST to learn how to write nodes (code-block globals, $('NodeName'), fetch, examples), get_workflow_schema for the exact JSON shape, read_workflow(view:'graph') to see the current graph, then edit: edit_node_code for surgical find/replace inside one node's code (preferred for code changes — no resending big strings), edit_workflow with a small patch for structural changes (both validate and save a version; fix any returned error and retry). Run with run_workflow and inspect with get_run(include:['timeline','io']).\n\n" +
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
  return callerKey.run(key, () =>
    projectId ? callerProject.run(projectId, () => baseHandler(req)) : baseHandler(req)
  );
};

const handleOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export { authed as GET, authed as POST, authed as DELETE, handleOptions as OPTIONS };

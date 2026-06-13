import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

/**
 * Automat Robotic Workflows MCP Server.
 *
 * Stateless Streamable-HTTP endpoint (plain Vercel Function). Each tool forwards
 * to the studio "thin client" — the project-scoped v1 API under /api/v1/... —
 * authenticating with a project-scoped key (ak_...). The project is resolved
 * from that key server-side, so no projectId is sent.
 *
 * Contract reference: README.md (Tools section).
 */

// ---------------------------------------------------------------------------
// Inbound auth — the key MCP clients use to reach THIS server.
// ---------------------------------------------------------------------------
// Set via the Vercel env. This server now proxies REAL workflow mutations, so the
// inbound key must NOT be hardcoded/committed — keep it an env-only secret and
// rotate the old throwaway value.
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";

// ---------------------------------------------------------------------------
// Outbound — the studio v1 API this server forwards to.
// ---------------------------------------------------------------------------
// ⚠️ STUDIO_API_BASE_URL must point at the v1 API origin. Vercel PREVIEW URLs
//    change per deploy — set this (and STUDIO_API_KEY) in the Vercel env rather
//    than relying on the defaults below. Protected previews also need
//    VERCEL_AUTOMATION_BYPASS_SECRET.
const STUDIO_API_BASE_URL = (
  process.env.STUDIO_API_BASE_URL ??
  "https://studio-phfamfo8s-automat-4a06a9d7.vercel.app"
).replace(/\/$/, "");
// ⚠️ Project-scoped studio key (ak_…). SECRET — never hardcode/commit. Set in the Vercel env.
const STUDIO_API_KEY = process.env.STUDIO_API_KEY ?? "";
const VERCEL_BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

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

// ---------------------------------------------------------------------------
// Studio API client
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(public status: number, public apiCode: string, message: string) {
    super(message);
  }
}

interface ApiOpts {
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
}

async function api(method: string, path: string, opts: ApiOpts = {}): Promise<any> {
  if (!STUDIO_API_KEY) throw new ApiError(500, "config_error", "STUDIO_API_KEY is not set on the MCP server.");
  const url = new URL(STUDIO_API_BASE_URL + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${STUDIO_API_KEY}`,
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
    throw new ApiError(res.status, String(apiCode), String(message));
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
    return result({ error: { code: ourCode(e.status), status: e.status, message: e.message } });
  }
  return result({ error: { code: "internal_error", message: e instanceof Error ? e.message : String(e) } });
}

const comingSoon = (message: string) =>
  result({ coming_soon: true, message: `Coming soon: ${message}` });

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
    if (unknown.length) throw new Error(`Cannot remove unknown node(s): ${unknown.join(", ")}`);
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
      if (idx === -1) throw new Error(`Cannot update unknown node "${name}".`);
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
const Environment = z.enum(["development", "staging", "preview", "production"]);
const Lifecycle = z.enum(["development", "preview", "active"]);
const DefinitionInput = z
  .record(z.string(), z.unknown())
  .describe("Full @automat/runtime WorkflowSchema definition. Call get_workflow_schema for the exact shape; validated server-side.");
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
  .describe("Composite patch. Send only what changes. Top-level WorkflowSchema fields also accepted (settings deep-merges; others replace). Applied: nodes.remove → nodes.add → nodes.update → edges.remove → edges.add → top-level.");
const limit = z.number().int().min(1).max(100).describe("Page size (default 25, max 100).").optional();
const cursor = z.string().describe("Pagination cursor from a previous response's nextCursor.").optional();

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPSERT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const REMOVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// Shape mappers (API → our documented tool output)
const mapWorkflow = (w: any) => ({
  workflowId: w.id,
  name: w.name,
  description: w.description ?? null,
  status: w.lifecycle,
  activeVersionId: w.activeVersionId ?? null,
  apiEnabled: w.apiEnabled,
  apiUrlSlug: w.apiUrlSlug ?? null,
  updatedAt: w.updatedAt,
});

// Resolve a secret/resource id by name (the v1 API addresses these by id).
async function findSecretId(name: string): Promise<string | null> {
  const r = await api("GET", "/api/v1/secrets", { query: { name, pageSize: 1 } });
  return r.secrets?.[0]?.id ?? null;
}
async function findResource(name: string, lifecycle?: string): Promise<any | null> {
  const r = await api("GET", "/api/v1/resources", { query: { name, lifecycle, pageSize: 1 } });
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
      "get_workflow_schema",
      {
        title: "Get workflow schema",
        description:
          "Returns the JSON Schema for an Automat workflow definition. Call before creating or editing a workflow to learn the exact node/edge/settings shape. Returns: { runtimeVersion, jsonSchema }.",
        inputSchema: { runtimeVersion: z.string().describe("Defaults to 'latest'.").optional() },
        annotations: RO,
      },
      async ({ runtimeVersion }) => {
        try {
          const r = await api("GET", "/api/v1/schema");
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
          const r = await api("GET", "/api/v1/workflows", { query: { page, pageSize: lim ?? 25 } });
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
          const r = await api("POST", "/api/v1/workflows", { body: { definition: def, name } });
          return result({
            workflowId: r.workflow?.id,
            versionId: r.version?.id,
            versionNumber: r.version?.versionNumber,
            status: r.workflow?.lifecycle ?? "development",
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
          const src = await api("GET", `/api/v1/workflows/${workflowId}`);
          const def = src.workflow?.activeVersion?.definition;
          if (!def) return result({ error: { code: "not_found", message: "Source workflow has no active version to copy." } });
          const newName = name ?? `Copy of ${src.workflow?.name ?? "workflow"}`;
          const created = { ...def, name: newName };
          const r = await api("POST", "/api/v1/workflows", { body: { definition: created, name: newName } });
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
          "Reads a workflow's active definition. ALWAYS read before editing. view: 'graph' (nodes/edges + metadata, no node code), 'node' (one node, needs nodeName), 'full' (entire definition). Returns the view plus _meta — pass _meta.versionId as expectedActiveVersionId to edit_workflow.",
        inputSchema: {
          workflowId: z.string(),
          view: z.enum(["graph", "node", "full"]),
          nodeName: z.string().describe("Required when view='node'.").optional(),
        },
        annotations: RO,
      },
      async ({ workflowId, view, nodeName }) => {
        try {
          const r = await api("GET", `/api/v1/workflows/${workflowId}`);
          const w = r.workflow;
          if (!w) return result({ error: { code: "not_found", message: "Workflow not found." } });
          const def = w.activeVersion?.definition ?? null;
          const meta = {
            workflowId: w.id,
            versionId: w.activeVersionId ?? null,
            versionNumber: w.activeVersion?.versionNumber ?? null,
            status: w.lifecycle,
            apiEnabled: w.apiEnabled,
            apiUrlSlug: w.apiUrlSlug ?? null,
          };
          if (!def) return result({ _meta: meta, definition: null, note: "Workflow has no active version yet." });
          if (view === "node") {
            if (!nodeName) return result({ error: { code: "bad_request", message: "nodeName is required when view='node'." } });
            const node = (def.nodes ?? []).find((n: any) => n.name === nodeName);
            return node ? result({ _meta: meta, node }) : result({ error: { code: "not_found", message: `No node named "${nodeName}".` } });
          }
          if (view === "full") return result({ _meta: meta, definition: def });
          // graph: strip per-node code/execute, keep routing-critical fields
          const nodes = (def.nodes ?? []).map((n: any) => ({
            name: n.name, type: n.type, position: n.position,
            ...(n.mode ? { mode: n.mode } : {}),
            ...(n.expression ? { expression: n.expression } : {}),
            ...(n.extractorId ? { extractorId: n.extractorId } : {}),
            ...(n.instructions ? { instructions: n.instructions } : {}),
          }));
          return result({
            _meta: meta,
            name: def.name, description: def.description, settings: def.settings,
            inputSchema: def.inputSchema, outputSchema: def.outputSchema,
            nodes, edges: def.edges ?? [],
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
          "Updates lifecycle status and API-trigger config. status: preview | active | disabled (activating needs a published version). NOTE: name/description editing and status='development' are not yet supported by the API. Returns the updated { workflowId, name, status, apiEnabled, apiUrlSlug }.",
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
        if (name !== undefined || description !== undefined)
          return comingSoon("editing a workflow's name/description via update_workflow — the v1 API PATCH only accepts status/apiEnabled/apiUrlSlug.");
        if (status === "development")
          return comingSoon("setting status back to 'development' — the v1 API PATCH only allows preview/active/disabled.");
        if (status === undefined && apiEnabled === undefined && apiUrlSlug === undefined)
          return result({ error: { code: "bad_request", message: "Provide at least one of status, apiEnabled, apiUrlSlug." } });
        try {
          const r = await api("PATCH", `/api/v1/workflows/${workflowId}`, { body: { status, apiEnabled, apiUrlSlug } });
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
          const r = await api("DELETE", `/api/v1/workflows/${workflowId}`);
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
          "Applies a composite patch to a workflow's graph and saves a new version. Read the graph first, then send only what changes in `patch`. Validated server-side; on success a new version, on failure an error. Pass expectedActiveVersionId (from read_workflow's _meta) to avoid clobbering concurrent edits. Returns: { ok, versionId, versionNumber, deduped } or { error }.",
        inputSchema: {
          workflowId: z.string(),
          patch: WorkflowPatchInput,
          expectedActiveVersionId: z.string().describe("From read_workflow's _meta.versionId.").optional(),
        },
        annotations: CREATE,
      },
      async ({ workflowId, patch, expectedActiveVersionId }) => {
        try {
          const cur = await api("GET", `/api/v1/workflows/${workflowId}`);
          const w = cur.workflow;
          if (!w) return result({ error: { code: "not_found", message: "Workflow not found." } });
          const current = w.activeVersion?.definition;
          if (!current) return result({ error: { code: "bad_request", message: "Workflow has no version to edit. Create one first." } });
          let next: any;
          try {
            next = applyWorkflowPatch(current, patch);
          } catch (patchErr) {
            return result({ error: { code: "validation_failed", message: patchErr instanceof Error ? patchErr.message : String(patchErr) } });
          }
          const r = await api("PUT", `/api/v1/workflows/${workflowId}`, {
            body: { definition: next, name: next.name, expectedActiveVersionId: expectedActiveVersionId ?? w.activeVersionId },
          });
          return result({ ok: true, versionId: r.version?.id, versionNumber: r.version?.versionNumber, deduped: r.version?.deduped ?? false });
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
          const r = await api("GET", `/api/v1/workflows/${workflowId}/versions`, { query: { page, pageSize: lim ?? 25 } });
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
      async () => comingSoon("single-version retrieval — the v1 API has no GET /workflows/{id}/versions/{versionId} (the version list omits definitions)."),
    );

    server.registerTool(
      "revert_to_version",
      {
        title: "Revert to version",
        description: "Reverts a workflow to an earlier version by appending it as a new version.",
        inputSchema: { workflowId: z.string(), versionId: z.string(), expectedActiveVersionId: z.string().optional() },
        annotations: CREATE,
      },
      async () => comingSoon("version revert — depends on single-version retrieval (get_version), which the v1 API does not expose yet."),
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
          const r = await api("GET", `/api/v1/workflows/${workflowId}/schedules`);
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
          "Creates a recurring schedule using an RFC 5545 recurrence rule (e.g. 'FREQ=DAILY;BYHOUR=9'). Run input comes from a linked project resource (inputResourceName). Returns: { scheduleId }. (timezone/enabled on create are not supported by the API yet.)",
        inputSchema: {
          workflowId: z.string(),
          recurrenceRule: z.string().describe("RFC 5545 RRULE."),
          name: z.string().optional(),
          startAt: z.string().describe("ISO 8601 datetime.").optional(),
          timezone: z.string().optional(),
          enabled: z.boolean().optional(),
          inputResourceName: z.string().optional(),
        },
        annotations: CREATE,
      },
      async ({ workflowId, recurrenceRule, name, startAt, inputResourceName }) => {
        try {
          const r = await api("POST", `/api/v1/workflows/${workflowId}/schedules`, {
            body: { name: name ?? null, recurrence_rule: recurrenceRule, start_at: startAt, input_resource_name: inputResourceName ?? null },
          });
          return result({ scheduleId: r.schedule?.id });
        } catch (e) {
          return fail(e);
        }
      },
    );

    server.registerTool(
      "update_schedule",
      {
        title: "Update schedule",
        description: "Updates a schedule. Set `enabled` to pause/resume (maps to status active/paused). Returns: { scheduleId }.",
        inputSchema: {
          workflowId: z.string(),
          scheduleId: z.string(),
          recurrenceRule: z.string().optional(),
          name: z.string().optional(),
          startAt: z.string().optional(),
          timezone: z.string().optional(),
          enabled: z.boolean().optional(),
          inputResourceName: z.string().optional(),
        },
        annotations: UPSERT,
      },
      async ({ workflowId, scheduleId, recurrenceRule, name, startAt, enabled, inputResourceName }) => {
        try {
          const body: Record<string, unknown> = {};
          if (name !== undefined) body.name = name;
          if (recurrenceRule !== undefined) body.recurrence_rule = recurrenceRule;
          if (startAt !== undefined) body.start_at = startAt;
          if (inputResourceName !== undefined) body.input_resource_name = inputResourceName;
          if (enabled !== undefined) body.status = enabled ? "active" : "paused";
          const r = await api("PATCH", `/api/v1/workflows/${workflowId}/schedules/${scheduleId}`, { body });
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
          const r = await api("DELETE", `/api/v1/workflows/${workflowId}/schedules/${scheduleId}`);
          return result({ success: r.success === true, scheduleId });
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
          "Triggers a run of the workflow's active version. `input` is validated against the workflow's input schema. (The environment is chosen server-side.) Returns: { sessionId, status: 'queued' } — poll get_run.",
        inputSchema: {
          workflowId: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
          environment: Environment.optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ workflowId, input }) => {
        try {
          const r = await api("POST", `/api/v1/workflows/${workflowId}/run`, { body: input ?? {} });
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
          const r = await api("GET", "/api/v1/sessions", { query: { workflowId, page, pageSize: lim ?? 25 } });
          let items = (r.sessions ?? []).map((s: any) => ({
            sessionId: s.id, workflowId: s.workflowId, status: s.status, source: s.source ?? null,
            startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null,
            durationMs: s.durationSeconds != null ? Math.round(s.durationSeconds * 1000) : null,
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
          "Returns a run's status and result; add `include` for deeper data. include: 'timeline' (per-node status+timing), 'io' (per-node input/output). NOTE: 'logs' and 'recording' are not yet exposed by the API.",
        inputSchema: {
          sessionId: z.string(),
          include: z.array(z.enum(["timeline", "io", "logs", "recording"])).optional(),
          logsCursor: z.string().optional(),
        },
        annotations: RO,
      },
      async ({ sessionId, include }) => {
        try {
          const inc = new Set(include ?? []);
          const r = await api("GET", `/api/v1/sessions/${sessionId}`);
          const s = r.session;
          if (!s) return result({ error: { code: "not_found", message: "Run not found." } });
          const out: Record<string, unknown> = {
            sessionId: s.id, workflowId: s.workflowId, versionId: s.workflowVersionId ?? null,
            status: s.status, source: s.source ?? null, input: s.inputData ?? null, output: s.outputData ?? null,
            startedAt: s.startedAt ?? null, endedAt: s.endedAt ?? null,
            durationMs: s.durationSeconds != null ? Math.round(s.durationSeconds * 1000) : null,
          };
          if (inc.has("timeline") || inc.has("io")) {
            const n = await api("GET", `/api/v1/sessions/${sessionId}/nodes`);
            const nodes = n.nodes ?? [];
            if (inc.has("timeline"))
              out.timeline = nodes.map((nd: any) => ({ name: nd.name, type: nd.type, status: nd.status, startedAt: nd.startedAt, endedAt: nd.endedAt, durationMs: durMs(nd.startedAt, nd.endedAt) }));
            if (inc.has("io"))
              out.nodeIO = nodes.map((nd: any) => ({ name: nd.name, input: nd.inputData ?? null, output: nd.outputData ?? null }));
          }
          if (inc.has("logs") || inc.has("recording"))
            out.note = "Coming soon: logs and recording are not yet exposed by the API.";
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
          const r = await api("POST", `/api/v1/sessions/${sessionId}/stop`);
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
      async () => comingSoon("HITL task listing — the v1 API does not expose /hitl yet (only the internal /api/projects surface)."),
    );

    server.registerTool(
      "complete_hitl_task",
      {
        title: "Complete human-in-the-loop task",
        description: "Submits a human decision to resume a paused run.",
        inputSchema: { taskId: z.string(), action: z.string(), fields: z.record(z.string(), z.unknown()).optional() },
        annotations: CREATE,
      },
      async () => comingSoon("HITL task completion — the v1 API does not expose /hitl yet (only the internal /api/projects surface)."),
    );

    // ---- Secrets ----
    server.registerTool(
      "list_secrets",
      {
        title: "List secrets",
        description: "Lists the project's secret names and metadata (values are never returned). Returns: { items: [{ key, last4, lifecycle, updatedAt }], nextCursor }.",
        inputSchema: { lifecycle: Lifecycle.optional(), limit, cursor },
        annotations: RO,
      },
      async ({ lifecycle, limit: lim, cursor: cur }) => {
        try {
          const page = toPage(cur);
          const r = await api("GET", "/api/v1/secrets", { query: { lifecycle, page, pageSize: lim ?? 25 } });
          const items = (r.secrets ?? []).map((s: any) => ({ key: s.name, last4: s.last4 ?? null, lifecycle: s.lifecycle ?? null, updatedAt: s.updatedAt }));
          return result({ items, nextCursor: nextCursor(r.currentPage ?? page, r.totalPages ?? page) });
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
          secrets: z.array(z.object({ key: z.string(), value: z.string(), description: z.string().optional(), lifecycle: Lifecycle.optional() })).min(1),
        },
        annotations: UPSERT,
      },
      async ({ secrets }) => {
        try {
          const updated: string[] = [];
          for (const s of secrets) {
            const id = await findSecretId(s.key);
            if (id) await api("PUT", `/api/v1/secrets/${id}`, { body: { value: s.value, lifecycle: s.lifecycle } });
            else await api("POST", "/api/v1/secrets", { body: { name: s.key, value: s.value, lifecycle: s.lifecycle } });
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
        inputSchema: { key: z.string() },
        annotations: REMOVE,
      },
      async ({ key }) => {
        try {
          const id = await findSecretId(key);
          if (!id) return result({ error: { code: "not_found", message: `No secret named "${key}".` } });
          await api("DELETE", `/api/v1/secrets/${id}`);
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
          const r = await api("GET", "/api/v1/resources", { query: { lifecycle, name: search, page, pageSize: lim ?? 25 } });
          const items = (r.resources ?? []).map((x: any) => ({ name: x.name, kind: "data", description: x.description ?? null, lifecycle: x.lifecycle ?? null, updatedAt: x.updatedAt }));
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
          if (existing) await api("PUT", `/api/v1/resources/${existing.id}`, { body: { value, description } });
          else await api("POST", "/api/v1/resources", { body: { name, value, description, lifecycle } });
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
          await api("DELETE", `/api/v1/resources/${x.id}`);
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
      async () => comingSoon("extractor listing — the v1 API does not expose /extractors yet (only the internal /api/projects surface)."),
    );

    server.registerTool(
      "get_extractor",
      {
        title: "Get extractor",
        description: "Returns a document extractor.",
        inputSchema: { extractorId: z.string(), view: z.enum(["summary", "full"]).optional() },
        annotations: RO,
      },
      async () => comingSoon("extractor retrieval — the v1 API does not expose /extractors yet (only the internal /api/projects surface)."),
    );
  },
  {
    serverInfo: { name: "automat-robotic-workflows", version: "0.4.0" },
    instructions:
      "Build, run, and manage Automat RPA workflows in one project (the API key resolves the project; no project id is needed).\n\n" +
      "Build loop: get_workflow_schema for the node/edge shape, read_workflow(view:'graph') to see the current graph, then edit_workflow with a small patch (validates and saves a version; fix any returned error and retry). Run with run_workflow and inspect with get_run(include:['timeline','io']).\n\n" +
      "Model: each edit saves an immutable version; lifecycle is development → preview → active → disabled (update_workflow; activating needs a published version). Schedules use RFC 5545 rules and a linked project resource for input. Secrets are write-only.\n\n" +
      "Some tools return { coming_soon: true } until the backend exposes them (get_version, revert_to_version, HITL, extractors, and get_run logs/recording).",
  },
  { basePath: "/api", maxDuration: 60, verboseLogs: true },
);

// ---------------------------------------------------------------------------
// Auth-wrapped handler exports
// ---------------------------------------------------------------------------
const authed = async (req: Request): Promise<Response> => {
  if (!MCP_API_KEY) {
    return new Response(JSON.stringify({ error: "server_misconfigured", message: "MCP_API_KEY is not set" }), {
      status: 500,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  }
  if (extractKey(req) !== MCP_API_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", ...corsHeaders },
    });
  }
  return baseHandler(req);
};

const handleOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export { authed as GET, authed as POST, authed as DELETE, handleOptions as OPTIONS };

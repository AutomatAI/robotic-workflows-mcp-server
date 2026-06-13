import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

/**
 * Automat Robotic Workflows MCP Server.
 *
 * Single stateless Streamable-HTTP endpoint deployed as a plain Vercel Function.
 *
 * STATUS: the tools below are **schema-complete stubs**. Every tool has its real
 * input schema and returns a realistic, spec-shaped response marked `_stub: true`.
 * They are NOT yet wired to studio — once the studio "thin client" (API-key-authed,
 * single-project-scoped endpoints) is ready, each handler forwards to it.
 *
 * The authoritative contract for the thin client lives in `README.md` (Tools section).
 * Point your agent at this repo: the README + these schemas fully describe what the
 * thin client must expose.
 */

// ---------------------------------------------------------------------------
// Auth — single shared static API key, single-project-scoped.
// ---------------------------------------------------------------------------
// ⚠️ v1 key is hardcoded so the server deploys with zero env config. It guards
// stub tools only. Rotate by setting MCP_API_KEY in the Vercel env.
const MCP_API_KEY =
  process.env.MCP_API_KEY ??
  "a0493f411923a3cd46b690a0857e0f296872560b4dba048827e7f3f4bccb4439";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, authorization, x-api-key, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

/** API key from ?api_key= (connector UI), x-api-key, or Authorization: Bearer. */
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
// Stub helpers + fake data (replaced by thin-client calls later)
// ---------------------------------------------------------------------------
const now = () => new Date().toISOString();
const stub = (data: Record<string, unknown>) => ({
  content: [
    { type: "text" as const, text: JSON.stringify({ _stub: true, ...data }, null, 2) },
  ],
});

const WF_ID = "11111111-1111-1111-1111-111111111111";
const VERSION_ID = "22222222-2222-2222-2222-222222222222";
const SESSION_ID = "33333333-3333-3333-3333-333333333333";

/** A minimal valid-shaped workflow definition (start → block → end). */
const SAMPLE_DEFINITION = {
  name: "Sample Workflow",
  description: "A stub workflow definition.",
  runtimeVersion: "latest",
  settings: { browser: { headless: true }, retry: { maxAttempts: 1 } },
  nodes: [
    { type: "start", name: "Start", position: { x: 0, y: 0 } },
    {
      type: "block",
      name: "DoWork",
      mode: "code",
      code: "logger.info('hello'); return { ok: true };",
      position: { x: 240, y: 0 },
    },
    { type: "end", name: "End", position: { x: 480, y: 0 } },
  ],
  edges: [
    { from: "Start", to: "DoWork" },
    { from: "DoWork", to: "End" },
  ],
};

// Shared enums
const WorkflowStatus = z.enum(["development", "preview", "active", "disabled"]);
const RunStatus = z.enum([
  "pending",
  "queued",
  "executing",
  "paused",
  "completed",
  "failed",
  "canceled",
]);
const Environment = z.enum(["development", "staging", "preview", "production"]);

// Loosely-typed graph payloads — the canonical @automat/runtime WorkflowSchema is
// validated server-side by the thin client. Call get_workflow_schema for the shape.
const DefinitionInput = z
  .record(z.string(), z.unknown())
  .describe(
    "Full @automat/runtime WorkflowSchema definition. Call get_workflow_schema for the exact shape; validated server-side.",
  );

const WorkflowPatchInput = z
  .object({
    nodes: z
      .object({
        add: z.array(z.record(z.string(), z.unknown())).optional(),
        update: z
          .array(
            z.object({
              name: z.string().describe("Name of the node to update."),
              patch: z
                .record(z.string(), z.unknown())
                .describe("Shallow-merged fields. Set `name` to rename (edges auto-rewrite)."),
            }),
          )
          .optional(),
        remove: z.array(z.string()).describe("Node names to remove.").optional(),
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
    "Composite WorkflowPatch. Top-level WorkflowSchema fields are also accepted (settings deep-merges; others replace). Applied: nodes.remove → nodes.add → nodes.update → edges.remove → edges.add → top-level.",
  );

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
const baseHandler = createMcpHandler(
  (server) => {
    // ---- Connectivity ----------------------------------------------------
    server.tool(
      "ping",
      "Health check. Returns 'pong' plus server time. Confirms the connection is live.",
      {},
      async () => ({ content: [{ type: "text", text: `pong @ ${now()}` }] }),
    );

    server.tool(
      "echo",
      "Echo a message back (round-trip / argument-passing test).",
      { message: z.string().describe("Text to echo back") },
      async ({ message }) => ({
        content: [{ type: "text", text: `You said: ${message}` }],
      }),
    );

    // ---- A. Context & schema --------------------------------------------
    server.tool(
      "list_runtime_versions",
      "List the runtime versions a workflow can be pinned to. Only needed to choose a non-default version; get_workflow_schema and create_workflow default to 'latest'.",
      {},
      async () =>
        stub({
          versions: [
            { version: "0.12.0", isLatest: true, releasedAt: now() },
            { version: "0.11.0", isLatest: false, releasedAt: now() },
          ],
        }),
    );

    server.tool(
      "get_workflow_schema",
      "Return the workflow/node JSON schema + node catalog + examples so you can construct valid definitions and edit_workflow patches. Defaults to the latest runtime version.",
      {
        runtimeVersion: z
          .string()
          .describe("Runtime version to pin the schema to. Defaults to 'latest'.")
          .optional(),
      },
      async ({ runtimeVersion }) =>
        stub({
          runtimeVersion: runtimeVersion ?? "latest",
          nodeCatalog: [
            { type: "start", summary: "Entry point (exactly one).", requiredFields: ["name", "position"] },
            { type: "end", summary: "Exit point (passthrough).", requiredFields: ["name", "position"] },
            { type: "block", summary: "Code or AI-execute step.", requiredFields: ["name", "position", "mode"] },
            { type: "decision", summary: "Boolean routing (true/false handles).", requiredFields: ["name", "position", "expression"] },
            { type: "document", summary: "Extract data from files via an extractor.", requiredFields: ["name", "position", "extractorId", "fileInputs"] },
            { type: "hitl", summary: "Human-in-the-loop pause/resume.", requiredFields: ["name", "position", "prompt", "actions"] },
          ],
          edgeRules: "Edges are { from, to, handle? }. handle is 'true'/'false' for decision, action id or 'timeout' for hitl.",
          jsonSchema: { note: "STUB — thin client serves the real JSON Schema from @automat/runtime." },
          examples: [{ title: "start → block → end", definition: SAMPLE_DEFINITION }],
        }),
    );

    // ---- B. Workflow CRUD -----------------------------------------------
    server.tool(
      "list_workflows",
      "List workflows in the project (scoped to the API key). Supports status filter, search, and pagination.",
      {
        status: WorkflowStatus.optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      async () =>
        stub({
          items: [
            {
              workflowId: WF_ID,
              name: "Sample Workflow",
              description: "A stub workflow.",
              status: "development",
              activeVersionId: VERSION_ID,
              apiEnabled: false,
              apiUrlSlug: null,
              sessionCount: 3,
              updatedAt: now(),
            },
          ],
          nextCursor: null,
        }),
    );

    server.tool(
      "create_workflow",
      "Create a new workflow (and its v1 version). If `definition` is omitted, a minimal start → end scaffold is created. `runtimeVersion` defaults to 'latest'.",
      {
        name: z.string().describe("Workflow name."),
        description: z.string().optional(),
        definition: DefinitionInput.optional(),
        runtimeVersion: z.string().describe("Defaults to 'latest'.").optional(),
      },
      async ({ name }) =>
        stub({ workflowId: WF_ID, name, versionId: VERSION_ID, versionNumber: 1, status: "development" }),
    );

    server.tool(
      "copy_workflow",
      "Clone an existing workflow into the same project (v1 = clone of the source's active version). Schedules and runs are not copied.",
      {
        workflowId: z.string().describe("Source workflow id."),
        name: z.string().describe("Name for the copy. Defaults to 'Copy of …'.").optional(),
      },
      async ({ name }) => stub({ workflowId: "44444444-4444-4444-4444-444444444444", name: name ?? "Copy of Sample Workflow" }),
    );

    server.tool(
      "read_workflow",
      "Read the current (active) workflow. view='graph' (metadata + nodes/edges, no per-node code — the cheap default), 'node' (one node's full content; requires nodeName), 'full' (entire definition).",
      {
        workflowId: z.string(),
        view: z.enum(["graph", "node", "full"]).describe("graph | node | full"),
        nodeName: z.string().describe("Required when view='node'.").optional(),
      },
      async ({ workflowId, view, nodeName }) => {
        const meta = {
          workflowId,
          versionId: VERSION_ID,
          versionNumber: 1,
          status: "development",
          apiEnabled: false,
          apiUrlSlug: null,
        };
        if (view === "node") {
          if (!nodeName) return stub({ error: { code: "bad_request", message: "nodeName is required when view='node'." } });
          const node = SAMPLE_DEFINITION.nodes.find((n) => n.name === nodeName);
          return node
            ? stub({ _meta: meta, node })
            : stub({ error: { code: "not_found", message: `No node named "${nodeName}".` } });
        }
        if (view === "full") return stub({ _meta: meta, definition: SAMPLE_DEFINITION });
        // graph
        return stub({
          _meta: meta,
          name: SAMPLE_DEFINITION.name,
          settings: SAMPLE_DEFINITION.settings,
          nodes: SAMPLE_DEFINITION.nodes.map((n) => ({ name: n.name, type: n.type, position: n.position })),
          edges: SAMPLE_DEFINITION.edges,
        });
      },
    );

    server.tool(
      "update_workflow",
      "Update workflow metadata, lifecycle status, and API-trigger config (NOT the graph — use edit_workflow for that). status='active' requires a published version.",
      {
        workflowId: z.string(),
        name: z.string().optional(),
        description: z.string().optional(),
        status: WorkflowStatus.optional(),
        apiEnabled: z.boolean().optional(),
        apiUrlSlug: z.string().optional(),
      },
      async ({ workflowId, name, description, status, apiEnabled, apiUrlSlug }) =>
        stub({
          workflowId,
          name: name ?? "Sample Workflow",
          description: description ?? "A stub workflow.",
          status: status ?? "development",
          apiEnabled: apiEnabled ?? false,
          apiUrlSlug: apiUrlSlug ?? null,
        }),
    );

    server.tool(
      "delete_workflow",
      "Soft-delete a workflow (cascades to its sessions, schedules, and event channels).",
      { workflowId: z.string() },
      async () => stub({ success: true }),
    );

    // ---- C. Editing (the build loop) ------------------------------------
    server.tool(
      "edit_workflow",
      "Apply a composite patch to the workflow's active definition. Auto-saves a new immutable version if the result is valid (1 edit = 1 version); returns field-level issues if invalid. No separate save tool.",
      {
        workflowId: z.string(),
        patch: WorkflowPatchInput,
        expectedActiveVersionId: z
          .string()
          .describe("Optimistic-concurrency token from the last read; rejects with version_conflict if stale.")
          .optional(),
      },
      async () => stub({ ok: true, versionId: VERSION_ID, versionNumber: 2, deduped: false }),
    );

    // ---- D. Versions -----------------------------------------------------
    server.tool(
      "list_versions",
      "List a workflow's versions (newest first), with pagination.",
      {
        workflowId: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
        named: z.boolean().describe("Only versions with a user-given name.").optional(),
        source: z.string().describe("Filter by source (manual_save, agent, import, revert, clone).").optional(),
      },
      async () =>
        stub({
          items: [
            { versionId: VERSION_ID, versionNumber: 1, name: null, source: "manual_save", author: "stub", createdAt: now(), isActive: true },
          ],
          nextCursor: null,
          activeVersionId: VERSION_ID,
        }),
    );

    server.tool(
      "get_version",
      "Get a single workflow version, including its full definition.",
      { workflowId: z.string(), versionId: z.string() },
      async ({ versionId }) =>
        stub({ versionId, versionNumber: 1, name: null, source: "manual_save", createdAt: now(), definition: SAMPLE_DEFINITION }),
    );

    server.tool(
      "revert_to_version",
      "Revert to a prior version (non-destructive clone-forward: appends the target definition as a new version).",
      {
        workflowId: z.string(),
        versionId: z.string(),
        expectedActiveVersionId: z.string().optional(),
      },
      async () => stub({ versionId: "55555555-5555-5555-5555-555555555555", versionNumber: 3, revertedFromVersionNumber: 1 }),
    );

    // ---- E. Schedules ----------------------------------------------------
    server.tool(
      "list_schedules",
      "List the schedules attached to a workflow, each with its most-recent run summary.",
      { workflowId: z.string() },
      async () =>
        stub({
          items: [
            {
              scheduleId: "66666666-6666-6666-6666-666666666666",
              name: "Daily",
              recurrenceRule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
              startAt: now(),
              timezone: "UTC",
              enabled: true,
              lastSession: { id: SESSION_ID, status: "completed", createdAt: now(), durationMs: 4200, errorMessage: null },
            },
          ],
        }),
    );

    server.tool(
      "create_schedule",
      "Create a schedule for a workflow. Uses an RFC 5545 recurrence rule; input is supplied via a linked project resource (inputResourceName), gated against the workflow's inputSchema.",
      {
        workflowId: z.string(),
        recurrenceRule: z.string().describe("RFC 5545 RRULE, e.g. 'FREQ=DAILY;BYHOUR=9'."),
        name: z.string().optional(),
        startAt: z.string().describe("ISO 8601 datetime.").optional(),
        timezone: z.string().optional(),
        enabled: z.boolean().optional(),
        inputResourceName: z.string().describe("Name of a project resource providing run input.").optional(),
      },
      async () => stub({ scheduleId: "66666666-6666-6666-6666-666666666666" }),
    );

    server.tool(
      "update_schedule",
      "Update a schedule. Set `enabled` to pause/resume.",
      {
        workflowId: z.string(),
        scheduleId: z.string(),
        recurrenceRule: z.string().optional(),
        name: z.string().optional(),
        startAt: z.string().optional(),
        timezone: z.string().optional(),
        enabled: z.boolean().optional(),
        inputResourceName: z.string().optional(),
      },
      async ({ scheduleId }) => stub({ scheduleId }),
    );

    server.tool(
      "delete_schedule",
      "Delete a schedule from a workflow.",
      { workflowId: z.string(), scheduleId: z.string() },
      async () => stub({ success: true }),
    );

    // ---- F. Run / monitor / debug ---------------------------------------
    server.tool(
      "run_workflow",
      "Trigger a run of the workflow's active version. Validates input against the workflow's inputSchema; fails (lifecycle_gated) if disabled or no active version.",
      {
        workflowId: z.string(),
        input: z.record(z.string(), z.unknown()).describe("Run input; validated against inputSchema.").optional(),
        environment: Environment.optional(),
      },
      async () => stub({ sessionId: SESSION_ID, status: "queued" }),
    );

    server.tool(
      "list_runs",
      "List recent runs (sessions), optionally filtered by workflow and status, with pagination.",
      {
        workflowId: z.string().optional(),
        status: RunStatus.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      async () =>
        stub({
          items: [
            { sessionId: SESSION_ID, workflowId: WF_ID, status: "completed", source: "api", startedAt: now(), endedAt: now(), durationMs: 4200 },
          ],
          nextCursor: null,
        }),
    );

    server.tool(
      "get_run",
      "Get run details. By default returns status + input/output. Use `include` to add per-node timeline, per-node IO, paginated logs, and/or the browser recording URL.",
      {
        sessionId: z.string(),
        include: z
          .array(z.enum(["timeline", "io", "logs", "recording"]))
          .describe("Opt-in deep data. Omit for a lightweight summary.")
          .optional(),
        logsCursor: z.string().describe("Pagination cursor for logs.").optional(),
      },
      async ({ sessionId, include }) => {
        const inc = new Set(include ?? []);
        const base: Record<string, unknown> = {
          sessionId,
          workflowId: WF_ID,
          versionId: VERSION_ID,
          status: "completed",
          source: "api",
          input: { example: "input" },
          output: { ok: true },
          outputSchemaValid: true,
          startedAt: now(),
          endedAt: now(),
          durationMs: 4200,
        };
        if (inc.has("timeline"))
          base.timeline = [
            { name: "Start", type: "start", status: "completed", startedAt: now(), endedAt: now(), durationMs: 5 },
            { name: "DoWork", type: "block", status: "completed", startedAt: now(), endedAt: now(), durationMs: 4100 },
            { name: "End", type: "end", status: "completed", startedAt: now(), endedAt: now(), durationMs: 5 },
          ];
        if (inc.has("io"))
          base.nodeIO = [{ name: "DoWork", input: { mode: "code" }, output: { ok: true } }];
        if (inc.has("logs"))
          base.logs = { entries: [{ ts: now(), level: "info", nodeName: "DoWork", message: "hello" }], nextCursor: null };
        if (inc.has("recording")) base.recordingUrl = "https://example.invalid/recordings/stub.mp4";
        return stub(base);
      },
    );

    server.tool(
      "cancel_run",
      "Cancel an in-progress run.",
      { sessionId: z.string() },
      async () => stub({ success: true, status: "canceled" }),
    );

    // ---- G. HITL ---------------------------------------------------------
    server.tool(
      "list_hitl_tasks",
      "List human-in-the-loop tasks (pending approvals/inputs that pause a run), optionally filtered by session and status.",
      {
        sessionId: z.string().optional(),
        status: z.enum(["pending", "completed", "expired"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      async () =>
        stub({
          items: [
            {
              taskId: "77777777-7777-7777-7777-777777777777",
              sessionId: SESSION_ID,
              workflowId: WF_ID,
              nodeName: "Approve",
              prompt: "Approve this action?",
              actions: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
              isApproval: true,
              fields: [],
              status: "pending",
              createdAt: now(),
              expiresAt: now(),
            },
          ],
          nextCursor: null,
        }),
    );

    server.tool(
      "complete_hitl_task",
      "Submit a human decision to resume a paused run. `action` is one of the task's action ids; `fields` supplies any requested field values.",
      {
        taskId: z.string(),
        action: z.string().describe("An action id from the task."),
        fields: z.record(z.string(), z.unknown()).optional(),
      },
      async () => stub({ success: true }),
    );

    // ---- H. Secrets (project-scoped; values never returned) --------------
    server.tool(
      "list_secrets",
      "List secret keys for the project (names + metadata only — values are never returned).",
      { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
      async () =>
        stub({
          items: [
            { key: "API_TOKEN", description: "Third-party API token", updatedAt: now() },
            { key: "DB_PASSWORD", description: null, updatedAt: now() },
          ],
          nextCursor: null,
        }),
    );

    server.tool(
      "set_secrets",
      "Create or update one or more secrets (upsert). Values are write-only and never echoed back.",
      {
        secrets: z
          .array(
            z.object({
              key: z.string(),
              value: z.string().describe("Secret value (write-only)."),
              description: z.string().optional(),
            }),
          )
          .min(1),
      },
      async ({ secrets }) => stub({ updated: secrets.map((s) => s.key) }),
    );

    server.tool(
      "delete_secret",
      "Delete a secret by key.",
      { key: z.string() },
      async () => stub({ success: true }),
    );

    // ---- I. Resources & extractors --------------------------------------
    server.tool(
      "list_resources",
      "List project resources (names + metadata only). Resources are referenced by name from block/document nodes and schedule inputs.",
      {
        kind: z.enum(["data", "file"]).optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
      async () =>
        stub({
          items: [
            { name: "customer_list", kind: "data", description: "Seed customers", updatedAt: now() },
            { name: "template.pdf", kind: "file", description: null, updatedAt: now() },
          ],
          nextCursor: null,
        }),
    );

    server.tool(
      "get_resource",
      "Get a project resource by name. Data resources return their value; file resources return a download URL + metadata.",
      { name: z.string() },
      async ({ name }) =>
        stub({ name, kind: "data", value: { example: "data" }, description: "Seed customers", updatedAt: now() }),
    );

    server.tool(
      "set_resource",
      "Create or update a DATA resource (JSON value). File-resource uploads are not yet supported.",
      {
        name: z.string(),
        value: z.unknown().describe("JSON value for the data resource."),
        description: z.string().optional(),
      },
      async ({ name }) => stub({ name }),
    );

    server.tool(
      "delete_resource",
      "Delete a project resource by name.",
      { name: z.string() },
      async () => stub({ success: true }),
    );

    server.tool(
      "list_extractors",
      "List document extractors available in the project. document nodes reference an extractor by extractorId.",
      { search: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
      async () =>
        stub({
          items: [
            { extractorId: "88888888-8888-8888-8888-888888888888", name: "Invoice Extractor", activeVersionId: "99999999-9999-9999-9999-999999999999", description: "Extracts invoice fields" },
          ],
          nextCursor: null,
        }),
    );

    server.tool(
      "get_extractor",
      "Get a document extractor. view='summary' (name + fields overview + active version) or 'full' (entire extractor definition). Authoring extractors is not yet supported.",
      { extractorId: z.string(), view: z.enum(["summary", "full"]).optional() },
      async ({ extractorId, view }) =>
        stub({
          extractorId,
          name: "Invoice Extractor",
          activeVersionId: "99999999-9999-9999-9999-999999999999",
          fields: view === "full" ? [{ name: "total", type: "number" }, { name: "vendor", type: "string" }] : ["total", "vendor"],
        }),
    );
  },
  {
    serverInfo: { name: "automat-robotic-workflows", version: "0.2.0" },
    instructions:
      "Automat Robotic Workflows MCP server. Tools to build, manage, run, and debug Automat RPA workflows: " +
      "discover schema (list_runtime_versions, get_workflow_schema); CRUD workflows (list/create/copy/read/update/delete_workflow); " +
      "edit the graph via a composite patch (edit_workflow, auto-saves a version); versions (list/get/revert); schedules; " +
      "run & monitor (run_workflow, list_runs, get_run, cancel_run); HITL; secrets; resources & extractors. " +
      "NOTE: tools currently return stub data (_stub: true) until the studio thin client is wired.",
  },
  { basePath: "/api", maxDuration: 60, verboseLogs: true },
);

// ---------------------------------------------------------------------------
// Auth-wrapped handler exports
// ---------------------------------------------------------------------------
const authed = async (req: Request): Promise<Response> => {
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

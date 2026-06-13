import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

/**
 * Automat Robotic Workflows MCP Server.
 *
 * Single stateless Streamable-HTTP endpoint deployed as a plain Vercel Function.
 *
 * STATUS: the tools below are **schema-complete stubs**. Every tool has its real
 * name, description, input schema, and annotations, and returns a realistic,
 * spec-shaped response marked `_stub: true`. They are NOT yet wired to studio —
 * once the studio "thin client" (API-key-authed, single-project-scoped endpoints)
 * is ready, each handler forwards to it.
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
    "Composite patch. Send only what changes. Top-level WorkflowSchema fields are also accepted (settings deep-merges; others replace). Applied in order: nodes.remove → nodes.add → nodes.update → edges.remove → edges.add → top-level.",
  );

// Tool annotations (hints; see MCP spec). RO = read-only & idempotent.
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const UPSERT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const REMOVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// Pagination params reused across list tools.
const limit = z.number().int().min(1).max(100).describe("Page size (default 25, max 100).").optional();
const cursor = z.string().describe("Pagination cursor from a previous response's nextCursor.").optional();

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
const baseHandler = createMcpHandler(
  (server) => {
    // ---- Context & schema -----------------------------------------------
    server.registerTool(
      "list_runtime_versions",
      {
        title: "List runtime versions",
        description:
          "Lists the Automat runtime versions a workflow can be pinned to. When to use: only when you need a version other than the default — get_workflow_schema and create_workflow default to the latest. Returns: { versions: [{ version, isLatest, releasedAt }] }.",
        annotations: RO,
      },
      async () =>
        stub({
          versions: [
            { version: "0.12.0", isLatest: true, releasedAt: now() },
            { version: "0.11.0", isLatest: false, releasedAt: now() },
          ],
        }),
    );

    server.registerTool(
      "get_workflow_schema",
      {
        title: "Get workflow schema",
        description:
          "Returns the JSON schema, node-type catalog, and worked examples for an Automat workflow definition. When to use: before creating or editing a workflow, to learn the exact shape of nodes, edges, and settings. Returns: { runtimeVersion, jsonSchema, nodeCatalog, edgeRules, examples }. Defaults to the latest runtime version.",
        inputSchema: {
          runtimeVersion: z.string().describe("Runtime version to pin the schema to. Defaults to 'latest'.").optional(),
        },
        annotations: RO,
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

    // ---- Workflows ------------------------------------------------------
    server.registerTool(
      "list_workflows",
      {
        title: "List workflows",
        description:
          "Lists workflows in the current project (the API key is scoped to one project). When to use: to find a workflow's id before reading, editing, or running it. Prefer the `search` filter over paging through everything. Returns: a page of { workflowId, name, status, activeVersionId, apiEnabled, apiUrlSlug, sessionCount, updatedAt } plus nextCursor.",
        inputSchema: {
          status: WorkflowStatus.describe("Filter by lifecycle status.").optional(),
          search: z.string().describe("Substring match on name/description.").optional(),
          limit,
          cursor,
        },
        annotations: RO,
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

    server.registerTool(
      "create_workflow",
      {
        title: "Create workflow",
        description:
          "Creates a new workflow and its first version in the current project. When to use: to start a new automation. Omit `definition` to get a minimal start → end scaffold you then build with edit_workflow. `runtimeVersion` defaults to the latest. Returns: { workflowId, versionId, versionNumber, status }.",
        inputSchema: {
          name: z.string().describe("Human-readable workflow name."),
          description: z.string().optional(),
          definition: DefinitionInput.optional(),
          runtimeVersion: z.string().describe("Defaults to 'latest'.").optional(),
        },
        annotations: CREATE,
      },
      async ({ name }) => stub({ workflowId: WF_ID, name, versionId: VERSION_ID, versionNumber: 1, status: "development" }),
    );

    server.registerTool(
      "copy_workflow",
      {
        title: "Copy workflow",
        description:
          "Clones an existing workflow into the same project; the copy's first version is the source's active version. When to use: to fork a workflow as a starting point. Schedules and run history are not copied. Returns: { workflowId, name }.",
        inputSchema: {
          workflowId: z.string().describe("Source workflow id."),
          name: z.string().describe("Name for the copy. Defaults to 'Copy of …'.").optional(),
        },
        annotations: CREATE,
      },
      async ({ name }) => stub({ workflowId: "44444444-4444-4444-4444-444444444444", name: name ?? "Copy of Sample Workflow" }),
    );

    server.registerTool(
      "read_workflow",
      {
        title: "Read workflow",
        description:
          "Reads a workflow's active definition. When to use: ALWAYS read before editing so your patch targets the current state. Pick the smallest view: 'graph' (nodes/edges + metadata, no node code — start here), 'node' (one node's full content, requires nodeName), 'full' (entire definition). Returns the view plus _meta — pass _meta.versionId as expectedActiveVersionId in your next edit_workflow call.",
        inputSchema: {
          workflowId: z.string(),
          view: z.enum(["graph", "node", "full"]).describe("graph | node | full"),
          nodeName: z.string().describe("Required when view='node'.").optional(),
        },
        annotations: RO,
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
        return stub({
          _meta: meta,
          name: SAMPLE_DEFINITION.name,
          settings: SAMPLE_DEFINITION.settings,
          nodes: SAMPLE_DEFINITION.nodes.map((n) => ({ name: n.name, type: n.type, position: n.position })),
          edges: SAMPLE_DEFINITION.edges,
        });
      },
    );

    server.registerTool(
      "update_workflow",
      {
        title: "Update workflow settings",
        description:
          "Updates a workflow's metadata, lifecycle status, and API-trigger config — NOT its graph (use edit_workflow for the graph). When to use: to rename, change description, publish/disable, or toggle API triggering. status='active' requires a published version; status='disabled' auto-pauses the workflow's schedules. Returns the updated { workflowId, name, description, status, apiEnabled, apiUrlSlug }.",
        inputSchema: {
          workflowId: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          status: WorkflowStatus.optional(),
          apiEnabled: z.boolean().describe("Whether the workflow can be triggered via its API URL.").optional(),
          apiUrlSlug: z.string().describe("Unique slug for the API trigger URL.").optional(),
        },
        annotations: UPSERT,
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

    server.registerTool(
      "delete_workflow",
      {
        title: "Delete workflow",
        description:
          "Soft-deletes a workflow and cascades to its sessions, schedules, and event channels. When to use: to remove a workflow the user no longer needs — confirm intent first. Returns: { success: true }.",
        inputSchema: { workflowId: z.string() },
        annotations: REMOVE,
      },
      async () => stub({ success: true }),
    );

    // ---- Editing --------------------------------------------------------
    server.registerTool(
      "edit_workflow",
      {
        title: "Edit workflow",
        description:
          "Applies a composite patch to a workflow's graph and auto-saves a new version. This is the primary way to build or modify a workflow. Workflow: read_workflow('graph') first, then send only what changes in `patch` (add/update/remove nodes and edges; top-level fields like settings/inputSchema). The patch is validated against the schema — on success you get a new version, on failure an `issues[]` list to fix and retry. Pass expectedActiveVersionId (from read_workflow's _meta) to avoid clobbering concurrent edits. Returns: { ok, versionId, versionNumber, deduped } or { error: { code, message, issues } }.",
        inputSchema: {
          workflowId: z.string(),
          patch: WorkflowPatchInput,
          expectedActiveVersionId: z
            .string()
            .describe("Optimistic-concurrency token from read_workflow's _meta.versionId; rejects with version_conflict if stale.")
            .optional(),
        },
        annotations: CREATE,
      },
      async () => stub({ ok: true, versionId: VERSION_ID, versionNumber: 2, deduped: false }),
    );

    // ---- Versions -------------------------------------------------------
    server.registerTool(
      "list_versions",
      {
        title: "List versions",
        description:
          "Lists a workflow's saved versions, newest first. When to use: to review history or find a version to inspect or revert to. Returns: a page of { versionId, versionNumber, name, source, author, createdAt, isActive } plus nextCursor and activeVersionId.",
        inputSchema: {
          workflowId: z.string(),
          named: z.boolean().describe("Only versions with a user-given name.").optional(),
          source: z.string().describe("Filter by source (manual_save, agent, import, revert, clone).").optional(),
          limit,
          cursor,
        },
        annotations: RO,
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

    server.registerTool(
      "get_version",
      {
        title: "Get version",
        description:
          "Returns a single saved version including its full definition. When to use: to inspect or diff a specific version. Returns: { versionId, versionNumber, name, source, createdAt, definition }.",
        inputSchema: { workflowId: z.string(), versionId: z.string() },
        annotations: RO,
      },
      async ({ versionId }) =>
        stub({ versionId, versionNumber: 1, name: null, source: "manual_save", createdAt: now(), definition: SAMPLE_DEFINITION }),
    );

    server.registerTool(
      "revert_to_version",
      {
        title: "Revert to version",
        description:
          "Reverts a workflow to an earlier version by appending that definition as a new version (non-destructive — history is preserved). When to use: to roll back a bad change. Returns: { versionId, versionNumber, revertedFromVersionNumber }.",
        inputSchema: {
          workflowId: z.string(),
          versionId: z.string().describe("The version to revert to."),
          expectedActiveVersionId: z.string().optional(),
        },
        annotations: CREATE,
      },
      async () => stub({ versionId: "55555555-5555-5555-5555-555555555555", versionNumber: 3, revertedFromVersionNumber: 1 }),
    );

    // ---- Schedules ------------------------------------------------------
    server.registerTool(
      "list_schedules",
      {
        title: "List schedules",
        description:
          "Lists the schedules attached to a workflow, each with its most-recent run summary. When to use: to review or manage recurring runs. Returns: items of { scheduleId, name, recurrenceRule, startAt, timezone, enabled, lastSession }.",
        inputSchema: { workflowId: z.string() },
        annotations: RO,
      },
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

    server.registerTool(
      "create_schedule",
      {
        title: "Create schedule",
        description:
          "Creates a recurring schedule for a workflow using an RFC 5545 recurrence rule (e.g. 'FREQ=DAILY;BYHOUR=9'). When to use: to run a workflow on a cadence. Run input comes from a linked project resource via inputResourceName (create it with set_resource first if needed); it is validated against the workflow's input schema. Returns: { scheduleId }.",
        inputSchema: {
          workflowId: z.string(),
          recurrenceRule: z.string().describe("RFC 5545 RRULE, e.g. 'FREQ=DAILY;BYHOUR=9'."),
          name: z.string().optional(),
          startAt: z.string().describe("ISO 8601 datetime for the first occurrence.").optional(),
          timezone: z.string().describe("IANA timezone, e.g. 'America/New_York'.").optional(),
          enabled: z.boolean().optional(),
          inputResourceName: z.string().describe("Name of a project resource providing run input.").optional(),
        },
        annotations: CREATE,
      },
      async () => stub({ scheduleId: "66666666-6666-6666-6666-666666666666" }),
    );

    server.registerTool(
      "update_schedule",
      {
        title: "Update schedule",
        description:
          "Updates a schedule. When to use: to change its cadence, input, or to pause/resume it (set `enabled`). Returns: { scheduleId }.",
        inputSchema: {
          workflowId: z.string(),
          scheduleId: z.string(),
          recurrenceRule: z.string().optional(),
          name: z.string().optional(),
          startAt: z.string().optional(),
          timezone: z.string().optional(),
          enabled: z.boolean().describe("Set false to pause, true to resume.").optional(),
          inputResourceName: z.string().optional(),
        },
        annotations: UPSERT,
      },
      async ({ scheduleId }) => stub({ scheduleId }),
    );

    server.registerTool(
      "delete_schedule",
      {
        title: "Delete schedule",
        description: "Deletes a schedule from a workflow. Returns: { success: true }.",
        inputSchema: { workflowId: z.string(), scheduleId: z.string() },
        annotations: REMOVE,
      },
      async () => stub({ success: true }),
    );

    // ---- Runs -----------------------------------------------------------
    server.registerTool(
      "run_workflow",
      {
        title: "Run workflow",
        description:
          "Triggers a run of a workflow's active version. When to use: to execute an automation now. `input` is validated against the workflow's input schema; fails if the workflow is disabled or has no active version. This launches real browser automation against external systems. Returns: { sessionId, status: 'queued' } — poll get_run for progress and results.",
        inputSchema: {
          workflowId: z.string(),
          input: z.record(z.string(), z.unknown()).describe("Run input; validated against the workflow's inputSchema.").optional(),
          environment: Environment.describe("Execution environment. Defaults to production.").optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async () => stub({ sessionId: SESSION_ID, status: "queued" }),
    );

    server.registerTool(
      "list_runs",
      {
        title: "List runs",
        description:
          "Lists recent runs (sessions), newest first, optionally filtered by workflow and status. When to use: to find a run to inspect. Returns: items of { sessionId, workflowId, status, source, startedAt, endedAt, durationMs } plus nextCursor.",
        inputSchema: {
          workflowId: z.string().optional(),
          status: RunStatus.optional(),
          limit,
          cursor,
        },
        annotations: RO,
      },
      async () =>
        stub({
          items: [
            { sessionId: SESSION_ID, workflowId: WF_ID, status: "completed", source: "api", startedAt: now(), endedAt: now(), durationMs: 4200 },
          ],
          nextCursor: null,
        }),
    );

    server.registerTool(
      "get_run",
      {
        title: "Get run",
        description:
          "Returns a run's status and result; add `include` for deeper data when debugging. When to use: to check progress, get output, or debug a failure. include options: 'timeline' (per-node status + timing), 'io' (per-node input/output — may be large), 'logs' (paginated), 'recording' (browser video URL). Omit include for a lightweight summary. Returns the run summary plus any requested sections.",
        inputSchema: {
          sessionId: z.string(),
          include: z
            .array(z.enum(["timeline", "io", "logs", "recording"]))
            .describe("Opt-in deep data. Omit for a lightweight summary.")
            .optional(),
          logsCursor: z.string().describe("Pagination cursor for logs.").optional(),
        },
        annotations: RO,
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
        if (inc.has("io")) base.nodeIO = [{ name: "DoWork", input: { mode: "code" }, output: { ok: true } }];
        if (inc.has("logs"))
          base.logs = { entries: [{ ts: now(), level: "info", nodeName: "DoWork", message: "hello" }], nextCursor: null };
        if (inc.has("recording")) base.recordingUrl = "https://example.invalid/recordings/stub.mp4";
        return stub(base);
      },
    );

    server.registerTool(
      "cancel_run",
      {
        title: "Cancel run",
        description: "Cancels an in-progress run. When to use: to stop a run that is no longer needed. Returns: { success: true, status: 'canceled' }.",
        inputSchema: { sessionId: z.string() },
        annotations: UPSERT,
      },
      async () => stub({ success: true, status: "canceled" }),
    );

    // ---- Human-in-the-loop ----------------------------------------------
    server.registerTool(
      "list_hitl_tasks",
      {
        title: "List human-in-the-loop tasks",
        description:
          "Lists human-in-the-loop tasks — approvals or inputs that have paused a run waiting for a person. When to use: to find tasks that need a decision. Returns: items of { taskId, sessionId, workflowId, nodeName, prompt, actions, isApproval, fields, status, expiresAt } plus nextCursor.",
        inputSchema: {
          sessionId: z.string().describe("Filter to one run's tasks.").optional(),
          status: z.enum(["pending", "completed", "expired"]).optional(),
          limit,
          cursor,
        },
        annotations: RO,
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

    server.registerTool(
      "complete_hitl_task",
      {
        title: "Complete human-in-the-loop task",
        description:
          "Submits a human decision to resume a paused run. When to use: to answer a pending HITL task. `action` must be one of the task's action ids; `fields` supplies any requested values. Returns: { success: true }.",
        inputSchema: {
          taskId: z.string(),
          action: z.string().describe("One of the task's action ids."),
          fields: z.record(z.string(), z.unknown()).describe("Values for any fields the task requested.").optional(),
        },
        annotations: CREATE,
      },
      async () => stub({ success: true }),
    );

    // ---- Secrets (project-scoped; values never returned) ----------------
    server.registerTool(
      "list_secrets",
      {
        title: "List secrets",
        description:
          "Lists the project's secret keys and metadata. Values are NEVER returned. When to use: to see which secrets exist before referencing them in a workflow. Returns: items of { key, description, updatedAt } plus nextCursor.",
        inputSchema: { limit, cursor },
        annotations: RO,
      },
      async () =>
        stub({
          items: [
            { key: "API_TOKEN", description: "Third-party API token", updatedAt: now() },
            { key: "DB_PASSWORD", description: null, updatedAt: now() },
          ],
          nextCursor: null,
        }),
    );

    server.registerTool(
      "set_secrets",
      {
        title: "Set secrets",
        description:
          "Creates or updates one or more project secrets (upsert). Values are write-only and never echoed back. When to use: to store credentials a workflow needs. Returns: { updated: [keys] }.",
        inputSchema: {
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
        annotations: UPSERT,
      },
      async ({ secrets }) => stub({ updated: secrets.map((s) => s.key) }),
    );

    server.registerTool(
      "delete_secret",
      {
        title: "Delete secret",
        description: "Deletes a project secret by key. Returns: { success: true }.",
        inputSchema: { key: z.string() },
        annotations: REMOVE,
      },
      async () => stub({ success: true }),
    );

    // ---- Resources ------------------------------------------------------
    server.registerTool(
      "list_resources",
      {
        title: "List resources",
        description:
          "Lists project resources (data and file) by name and metadata; values are not returned. When to use: to discover resources referenced by block/document nodes or schedule inputs. Returns: items of { name, kind, description, updatedAt } plus nextCursor.",
        inputSchema: {
          kind: z.enum(["data", "file"]).optional(),
          search: z.string().optional(),
          limit,
          cursor,
        },
        annotations: RO,
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

    server.registerTool(
      "get_resource",
      {
        title: "Get resource",
        description:
          "Returns a project resource by name. Data resources include their value; file resources include a download URL and metadata. Returns: the resource.",
        inputSchema: { name: z.string() },
        annotations: RO,
      },
      async ({ name }) =>
        stub({ name, kind: "data", value: { example: "data" }, description: "Seed customers", updatedAt: now() }),
    );

    server.registerTool(
      "set_resource",
      {
        title: "Set resource",
        description:
          "Creates or updates a data (JSON) resource (upsert). When to use: to store input data a workflow or schedule reads by name. File-resource uploads are not yet supported. Returns: { name }.",
        inputSchema: {
          name: z.string(),
          value: z.unknown().describe("JSON value for the data resource."),
          description: z.string().optional(),
        },
        annotations: UPSERT,
      },
      async ({ name }) => stub({ name }),
    );

    server.registerTool(
      "delete_resource",
      {
        title: "Delete resource",
        description: "Deletes a project resource by name. Returns: { success: true }.",
        inputSchema: { name: z.string() },
        annotations: REMOVE,
      },
      async () => stub({ success: true }),
    );

    // ---- Extractors -----------------------------------------------------
    server.registerTool(
      "list_extractors",
      {
        title: "List extractors",
        description:
          "Lists the document extractors available in the project. When to use: to find an extractorId for a `document` node. Returns: items of { extractorId, name, activeVersionId, description } plus nextCursor.",
        inputSchema: { search: z.string().optional(), limit, cursor },
        annotations: RO,
      },
      async () =>
        stub({
          items: [
            { extractorId: "88888888-8888-8888-8888-888888888888", name: "Invoice Extractor", activeVersionId: "99999999-9999-9999-9999-999999999999", description: "Extracts invoice fields" },
          ],
          nextCursor: null,
        }),
    );

    server.registerTool(
      "get_extractor",
      {
        title: "Get extractor",
        description:
          "Returns a document extractor. view='summary' gives name + fields overview + active version; view='full' gives the entire definition. When to use: to inspect an extractor before referencing it in a document node. Authoring extractors is not yet supported.",
        inputSchema: { extractorId: z.string(), view: z.enum(["summary", "full"]).optional() },
        annotations: RO,
      },
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
    serverInfo: { name: "automat-robotic-workflows", version: "0.3.0" },
    instructions:
      "Build, run, and manage Automat RPA workflows in one project (the API key is scoped to a single project, so no tool takes a project id).\n\n" +
      "Build loop: call get_workflow_schema for the node/edge shape, read_workflow(view:'graph') to see the current graph, then edit_workflow with a small patch — it validates and auto-saves a version; if it returns issues, fix them and retry. Run with run_workflow and inspect with get_run(include:['timeline','logs']).\n\n" +
      "Model: a workflow has an immutable version per edit; lifecycle is development → preview → active → disabled (update_workflow; activating needs a published version). document nodes need an extractorId (list_extractors); schedules and some inputs reference project resources by name (list_resources/set_resource). Secrets are write-only (values never returned).\n\n" +
      "NOTE: tools currently return placeholder data marked _stub:true until the studio backend is connected.",
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

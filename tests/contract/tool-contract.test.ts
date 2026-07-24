import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMemFallbackForTests,
  __resetRedisForTests,
  __setRedisForTests,
  type RememberedProjectRedis,
} from "../../api/mcp.js";
import studioContractProjection from "../../contracts/studio-programmatic-access-operations.json" with { type: "json" };
import {
  connectTestClient,
  createStudioFetchFixture,
  jsonResponse,
  parseTextResult,
  type RecordedStudioRequest,
} from "../helpers/mcp-harness.js";

type ToolClassification =
  | { kind: "local" }
  | { kind: "studio"; operations: readonly string[] }
  | { kind: "hybrid"; operations: readonly string[] };

const toolClassifications = {
  list_projects: { kind: "studio", operations: ["GET /api/v1/projects"] },
  set_project: { kind: "hybrid", operations: ["GET /api/v1/projects"] },
  list_runtime_versions: { kind: "local" },
  get_docs: { kind: "local" },
  get_workflow_schema: { kind: "studio", operations: ["GET /api/v1/schema"] },
  list_workflows: { kind: "studio", operations: ["GET /api/v1/projects/{projectId}/workflows"] },
  create_workflow: { kind: "studio", operations: ["POST /api/v1/projects/{projectId}/workflows"] },
  copy_workflow: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/workflows/{workflowId}",
      "POST /api/v1/projects/{projectId}/workflows",
    ],
  },
  read_workflow: {
    kind: "studio",
    operations: ["GET /api/v1/projects/{projectId}/workflows/{workflowId}"],
  },
  update_workflow: {
    kind: "studio",
    operations: ["PATCH /api/v1/projects/{projectId}/workflows/{workflowId}"],
  },
  delete_workflow: {
    kind: "studio",
    operations: ["DELETE /api/v1/projects/{projectId}/workflows/{workflowId}"],
  },
  edit_workflow: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/workflows/{workflowId}",
      "PUT /api/v1/projects/{projectId}/workflows/{workflowId}",
    ],
  },
  edit_node_code: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/workflows/{workflowId}",
      "PUT /api/v1/projects/{projectId}/workflows/{workflowId}",
    ],
  },
  list_versions: {
    kind: "studio",
    operations: ["GET /api/v1/projects/{projectId}/workflows/{workflowId}/versions"],
  },
  get_version: {
    kind: "studio",
    operations: ["GET /api/v1/projects/{projectId}/workflows/{workflowId}/versions/{versionId}"],
  },
  revert_to_version: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/workflows/{workflowId}",
      "POST /api/v1/projects/{projectId}/workflows/{workflowId}/versions/{versionId}/revert",
    ],
  },
  list_schedules: {
    kind: "studio",
    operations: ["GET /api/v1/projects/{projectId}/workflows/{workflowId}/schedules"],
  },
  create_schedule: {
    kind: "studio",
    operations: [
      "POST /api/v1/projects/{projectId}/workflows/{workflowId}/schedules",
      "PATCH /api/v1/projects/{projectId}/workflows/{workflowId}/schedules/{scheduleId}",
      "GET /api/v1/projects/{projectId}/workflows/{workflowId}/schedules",
    ],
  },
  update_schedule: {
    kind: "studio",
    operations: ["PATCH /api/v1/projects/{projectId}/workflows/{workflowId}/schedules/{scheduleId}"],
  },
  delete_schedule: {
    kind: "studio",
    operations: ["DELETE /api/v1/projects/{projectId}/workflows/{workflowId}/schedules/{scheduleId}"],
  },
  run_workflow: {
    kind: "studio",
    operations: ["POST /api/v1/projects/{projectId}/workflows/{workflowId}/run"],
  },
  list_runs: { kind: "studio", operations: ["GET /api/v1/projects/{projectId}/sessions"] },
  get_run: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/sessions/{sessionId}",
      "GET /api/v1/projects/{projectId}/sessions/{sessionId}/nodes",
      "GET /api/v1/projects/{projectId}/sessions/{sessionId}/logs",
    ],
  },
  cancel_run: {
    kind: "studio",
    operations: ["POST /api/v1/projects/{projectId}/sessions/{sessionId}/stop"],
  },
  list_hitl_tasks: {
    kind: "studio",
    operations: ["GET /api/v1/projects/{projectId}/hitl/tasks"],
  },
  complete_hitl_task: {
    kind: "studio",
    operations: ["POST /api/v1/projects/{projectId}/hitl/tasks/{taskId}/complete"],
  },
  list_secrets: { kind: "studio", operations: ["GET /api/v1/projects/{projectId}/secrets"] },
  set_secrets: {
    kind: "studio",
    operations: ["PUT /api/v1/projects/{projectId}/secrets/{secretName}"],
  },
  delete_secret: {
    kind: "studio",
    operations: ["DELETE /api/v1/projects/{projectId}/secrets/{secretName}"],
  },
  list_resources: { kind: "studio", operations: ["GET /api/v1/projects/{projectId}/resources"] },
  get_resource: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/resources",
      "GET /api/v1/projects/{projectId}/resources/{resourceId}",
    ],
  },
  set_resource: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/resources",
      "POST /api/v1/projects/{projectId}/resources",
      "PUT /api/v1/projects/{projectId}/resources/{resourceId}",
    ],
  },
  delete_resource: {
    kind: "studio",
    operations: [
      "GET /api/v1/projects/{projectId}/resources",
      "DELETE /api/v1/projects/{projectId}/resources/{resourceId}",
    ],
  },
  test_resource_api: {
    kind: "studio",
    operations: ["POST /api/v1/projects/{projectId}/resources/test-fetch"],
  },
  list_extractors: { kind: "studio", operations: ["GET /api/v1/projects/{projectId}/extractors"] },
  get_extractor: {
    kind: "studio",
    operations: ["GET /api/v1/projects/{projectId}/extractors/{extractorId}"],
  },
} as const satisfies Record<string, ToolClassification>;

const TOKEN_SELECTION_WARNING =
  "All callers sharing this PAT also share this remembered project. Prefer explicit project_id/x-project-id, a stable connection_id, or a unique PAT per bare connector.";

function createRedisFixture() {
  const values = new Map<string, string>();
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
    return "OK";
  });
  const client: RememberedProjectRedis = {
    get: get as RememberedProjectRedis["get"],
    set,
  };
  return { client, get, set, values };
}

beforeEach(() => {
  __resetMemFallbackForTests();
  __resetRedisForTests();
});

afterEach(() => {
  __resetMemFallbackForTests();
  __resetRedisForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Studio error mapping", () => {
  it("preserves generated stable error codes from Studio's code field", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse(
        { error: "Conflict", code: "resource_conflict", message: "The resource changed concurrently" },
        { status: 409 },
      ),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const response = parseTextResult(
        await client.callTool({
          name: "get_resource",
          arguments: { resourceId: "11111111-1111-4111-8111-111111111112" },
        }),
      ) as { error: { code: string; message: string } };

      expect(response.error).toEqual({
        code: "resource_conflict",
        status: 409,
        message: "The resource changed concurrently",
      });
    } finally {
      await client.close();
    }
  });

  it("preserves stable codes but sanitizes Studio 5xx messages", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse(
        { error: "Fetch failed", code: "resource_fetch_timeout", message: "private upstream detail" },
        { status: 502 },
      ),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const response = parseTextResult(
        await client.callTool({ name: "test_resource_api", arguments: { url: "https://example.com/data.json" } }),
      ) as { error: { code: string; message: string } };

      expect(response.error).toEqual({
        code: "resource_fetch_timeout",
        status: 502,
        message: "Studio request failed.",
      });
    } finally {
      await client.close();
    }
  });
});

describe("registered tool contract", () => {
  it("matches the characterized tool-name baseline without a numeric count invariant", async () => {
    const { client } = await connectTestClient();
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toMatchInlineSnapshot(`
        [
          "list_projects",
          "set_project",
          "list_runtime_versions",
          "get_docs",
          "get_workflow_schema",
          "list_workflows",
          "create_workflow",
          "copy_workflow",
          "read_workflow",
          "update_workflow",
          "delete_workflow",
          "edit_workflow",
          "edit_node_code",
          "list_versions",
          "get_version",
          "revert_to_version",
          "list_schedules",
          "create_schedule",
          "update_schedule",
          "delete_schedule",
          "run_workflow",
          "list_runs",
          "get_run",
          "cancel_run",
          "list_hitl_tasks",
          "complete_hitl_task",
          "list_secrets",
          "set_secrets",
          "delete_secret",
          "list_resources",
          "get_resource",
          "set_resource",
          "delete_resource",
          "test_resource_api",
          "list_extractors",
          "get_extractor",
        ]
      `);
      expect(new Set(names)).toEqual(new Set(Object.keys(toolClassifications)));
    } finally {
      await client.close();
    }
  });

  it("publishes complete metadata and classifies every tool operation", async () => {
    const { client } = await connectTestClient();
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.title, `${tool.name} title`).toBeTruthy();
        expect(tool.description, `${tool.name} description`).toBeTruthy();
        expect(tool.inputSchema.type, `${tool.name} input schema`).toBe("object");
        expect(tool.annotations, `${tool.name} annotations`).toBeDefined();
        expect(toolClassifications[tool.name as keyof typeof toolClassifications]).toBeDefined();
      }
    } finally {
      await client.close();
    }
  });

  it("exposes resource guidance and external-read metadata", async () => {
    const { client } = await connectTestClient();
    try {
      const docs = parseTextResult(
        await client.callTool({
          name: "get_docs",
          arguments: { topic: "resources" },
        }),
      );
      expect(docs).toEqual({
        resources: expect.stringContaining("environment control plane"),
      });

      const testResourceApi = (await client.listTools()).tools.find((tool) => tool.name === "test_resource_api");
      expect(testResourceApi?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    } finally {
      await client.close();
    }
  });

  it("keeps every classified Studio operation in the synchronized contract projection", () => {
    expect(studioContractProjection.contractId).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(Number.isInteger(studioContractProjection.revision)).toBe(true);
    expect(studioContractProjection.revision).toBe(2);

    const operationIds = studioContractProjection.operations.map((operation) => operation.operationId);
    const operationKeys = studioContractProjection.operations.map(
      (operation) => `${operation.method} ${operation.path}`,
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(new Set(operationKeys).size).toBe(operationKeys.length);

    const projected = new Set(operationKeys);
    for (const operation of studioContractProjection.operations) {
      expect(["none", "body", "query"], `${operation.operationId} requestLocation`).toContain(
        operation.requestLocation,
      );
      expect(["read", "write", "authorship"], `${operation.operationId} wrapperTier`).toContain(operation.wrapperTier);
      expect(operation.successStatus, `${operation.operationId} successStatus`).toBeGreaterThanOrEqual(100);
      expect(operation.successStatus, `${operation.operationId} successStatus`).toBeLessThan(600);
      expect(Array.isArray(operation.stableErrorCodes), `${operation.operationId} stableErrorCodes`).toBe(true);
      expect(new Set(operation.stableErrorCodes).size).toBe(operation.stableErrorCodes.length);
      if (operation.pagination !== null) {
        expect(operation.requestLocation, `${operation.operationId} pagination location`).toBe("query");
        expect(operation.pagination.style, `${operation.operationId} pagination style`).toBe("page_page_size");
      }
      expect(operation.requestSchema === null || typeof operation.requestSchema === "object").toBe(true);
      if (operation.effectiveTier !== null) {
        expect(operation.effectiveTier).toMatchObject({
          tier: expect.stringMatching(/^(read|write|authorship)$/),
          when: expect.any(String),
        });
      }
    }

    for (const [tool, classification] of Object.entries(toolClassifications)) {
      if (classification.kind === "local") continue;
      for (const operation of classification.operations) {
        expect(projected.has(operation), `${tool} classified operation ${operation}`).toBe(true);
      }
    }

    const byId = new Map(studioContractProjection.operations.map((operation) => [operation.operationId, operation]));
    expect(byId.get("projects.list")).toMatchObject({
      requestLocation: "query",
      wrapperTier: "read",
      successStatus: 200,
      pagination: { request: { maxPageSize: 100 }, response: { items: "projects" } },
    });
    expect(byId.get("workflows.list")).toMatchObject({
      requestLocation: "query",
      wrapperTier: "read",
      querySchema: {
        properties: {
          status: { enum: ["development", "preview", "active", "disabled"] },
          search: { type: "string" },
        },
      },
      pagination: { response: { items: "workflows" } },
    });
    expect(byId.get("workflows.create")).toMatchObject({
      requestLocation: "body",
      wrapperTier: "authorship",
      successStatus: 201,
      pagination: null,
    });
    expect(byId.get("workflows.get")).toMatchObject({
      wrapperTier: "read",
      effectiveTier: { tier: "authorship", when: expect.stringContaining("definition JSON") },
    });
    expect(byId.get("sessions.get_logs")).toMatchObject({
      wrapperTier: "read",
      successStatus: 404,
    });
    expect(byId.get("workflows.run")).toMatchObject({
      requestLocation: "body",
      wrapperTier: "write",
      successStatus: 202,
      pagination: null,
      stableErrorCodes: ["workflow_not_found"],
    });
    expect(byId.get("resources.list")).toMatchObject({ wrapperTier: "authorship" });
    expect(byId.get("resources.get")).toMatchObject({ wrapperTier: "authorship" });
    expect(byId.get("resources.create")).toMatchObject({
      wrapperTier: "authorship",
      requestSchema: { oneOf: expect.arrayContaining([expect.objectContaining({ additionalProperties: false })]) },
      stableErrorCodes: ["resource_conflict", "resource_invalid_config"],
    });
    expect(byId.get("resources.put")).toMatchObject({
      wrapperTier: "authorship",
      requestSchema: {
        required: ["value"],
        properties: {
          source: { enum: ["manual", "api", "workflow"] },
          config: { required: ["url"], additionalProperties: false },
        },
        additionalProperties: false,
      },
      stableErrorCodes: [
        "resource_conflict",
        "resource_invalid_config",
        "resource_not_found",
        "resource_source_conflict",
      ],
    });
    expect(byId.get("resources.test_fetch")).toMatchObject({
      method: "POST",
      path: "/api/v1/projects/{projectId}/resources/test-fetch",
      wrapperTier: "authorship",
      requestSchema: { required: ["url"] },
      stableErrorCodes: expect.arrayContaining(["resource_fetch_timeout", "resource_fetch_invalid_json"]),
    });
    expect(byId.get("versions.list")).toMatchObject({ wrapperTier: "authorship" });
    expect(byId.get("versions.get")).toMatchObject({
      wrapperTier: "read",
      effectiveTier: { tier: "authorship" },
    });
    expect(byId.get("secrets.list_names")).toMatchObject({ wrapperTier: "authorship" });
    expect(byId.get("extractors.list")).toMatchObject({ wrapperTier: "read" });
  });

  it("projects a representative upstream Studio contract deterministically", () => {
    const directory = mkdtempSync(join(tmpdir(), "automat-mcp-contract-"));
    const upstreamSource = join(process.cwd(), "tests/fixtures/studio-programmatic-access-contract.json");
    const reversedSource = join(directory, "reversed.json");
    const script = join(process.cwd(), "scripts/sync-studio-contract.mjs");
    try {
      const upstream = JSON.parse(readFileSync(upstreamSource, "utf8"));
      writeFileSync(
        reversedSource,
        JSON.stringify({
          ...upstream,
          operations: [...upstream.operations].reverse(),
        }),
      );

      const first = execFileSync(process.execPath, [script, "--stdout", upstreamSource], {
        encoding: "utf8",
      });
      const second = execFileSync(process.execPath, [script, "--stdout", reversedSource], {
        encoding: "utf8",
      });

      expect(second).toBe(first);
      expect(`${JSON.stringify(JSON.parse(first), null, 2)}\n`).toBe(first);
      expect(JSON.parse(first)).toEqual({
        contractId: "representative-studio-programmatic-access",
        revision: 7,
        operations: [
          {
            operationId: "projects.list",
            method: "GET",
            path: "/api/v1/projects",
            requestLocation: "query",
            requestSchema: null,
            querySchema: null,
            wrapperTier: "read",
            effectiveTier: null,
            successStatus: 200,
            pagination: expect.objectContaining({
              style: "page_page_size",
              request: expect.objectContaining({ maxPageSize: 100 }),
            }),
            stableErrorCodes: [],
          },
          {
            operationId: "workflows.create",
            method: "POST",
            path: "/api/v1/projects/{projectId}/workflows",
            requestLocation: "body",
            requestSchema: {
              properties: {
                definition: {
                  type: "object",
                },
              },
              required: ["definition"],
              type: "object",
            },
            querySchema: null,
            wrapperTier: "authorship",
            effectiveTier: null,
            successStatus: 201,
            pagination: null,
            stableErrorCodes: ["workflow_name_conflict"],
          },
          {
            operationId: "workflows.get",
            method: "GET",
            path: "/api/v1/projects/{projectId}/workflows/{workflowId}",
            requestLocation: "query",
            requestSchema: null,
            querySchema: {
              properties: {
                view: {
                  enum: ["meta", "full", "graph", "node"],
                  type: "string",
                },
              },
              type: "object",
            },
            wrapperTier: "read",
            effectiveTier: {
              tier: "authorship",
              when: "the response includes definition JSON",
            },
            successStatus: 200,
            pagination: null,
            stableErrorCodes: ["workflow_not_found"],
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["requestLocation", "wrapperTier", "successStatus", "pagination", "stableErrorCodes"])(
    "rejects an upstream operation missing required %s metadata",
    (field) => {
      const directory = mkdtempSync(join(tmpdir(), "automat-mcp-contract-invalid-"));
      const sourcePath = join(directory, "missing-field.json");
      const script = join(process.cwd(), "scripts/sync-studio-contract.mjs");
      try {
        const upstream = JSON.parse(
          readFileSync(join(process.cwd(), "tests/fixtures/studio-programmatic-access-contract.json"), "utf8"),
        );
        delete upstream.operations[0][field];
        writeFileSync(sourcePath, JSON.stringify(upstream));

        expect(() =>
          execFileSync(process.execPath, [script, "--stdout", sourcePath], {
            encoding: "utf8",
            stdio: "pipe",
          }),
        ).toThrow();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("keeps project-selection docs and rules aligned without a server-issued session claim", () => {
    const files = ["AGENTS.md", ".cursor/BUGBOT.md", ".cursor/rules/mcp-contract.md", "README.md", "RUBRIC.md"];
    const contents = files.map((file) => [file, readFileSync(join(process.cwd(), file), "utf8")] as const);

    for (const [file, content] of contents) {
      expect(content, `${file} explicit selector precedence`).toMatch(
        /project_id[\s\S]*x-project-id[\s\S]*(remembered )?`?set_project`?/i,
      );
      expect(content, `${file} token compatibility scope`).toMatch(/PAT-global|PAT-wide|token-only/i);
      expect(content, `${file} no server-issued mcp-session-id claim`).not.toMatch(
        /server[- ]issued[^.\n]*mcp-session-id|mcp-session-id[^.\n]*server[- ]issued/i,
      );
    }
  });

  it("keeps local Vercel startup outside the recursive framework dev script", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    expect(packageJson.scripts.dev).toBeUndefined();
    expect(packageJson.scripts["dev:local"]).toBe("vercel dev");
    expect(readme).toContain("pnpm run dev:local");
    expect(readme).not.toContain("pnpm run dev          # vercel dev");
  });

  it("verifies recorded fixture requests against declared operations for a representative sample of tools", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const cases: {
      tool: string;
      args: Record<string, unknown>;
      method: string;
      pathname: string;
      responder: () => Response;
    }[] = [
      {
        tool: "list_workflows",
        args: {},
        method: "GET",
        pathname: `/api/v1/projects/${projectId}/workflows`,
        responder: () => jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 }),
      },
      {
        tool: "create_workflow",
        args: { name: "Contract test workflow" },
        method: "POST",
        pathname: `/api/v1/projects/${projectId}/workflows`,
        responder: () =>
          jsonResponse({ workflow: { id: "workflow-1" }, version: { id: "version-1", versionNumber: 1 } }),
      },
      {
        tool: "update_workflow",
        args: { workflowId: "workflow-1", name: "Renamed" },
        method: "PATCH",
        pathname: `/api/v1/projects/${projectId}/workflows/workflow-1`,
        responder: () => jsonResponse({ workflow: { id: "workflow-1", name: "Renamed" } }),
      },
      {
        tool: "delete_workflow",
        args: { workflowId: "workflow-1" },
        method: "DELETE",
        pathname: `/api/v1/projects/${projectId}/workflows/workflow-1`,
        responder: () => jsonResponse({ deleted: true }),
      },
      {
        tool: "list_runs",
        args: {},
        method: "GET",
        pathname: `/api/v1/projects/${projectId}/sessions`,
        responder: () => jsonResponse({ sessions: [], currentPage: 1, totalPages: 1 }),
      },
      {
        tool: "list_secrets",
        args: { dopplerProject: "proj", dopplerConfig: "dev" },
        method: "GET",
        pathname: `/api/v1/projects/${projectId}/secrets`,
        responder: () => jsonResponse({ secrets: [] }),
      },
    ];

    for (const { tool, args, method, pathname, responder } of cases) {
      const classification = toolClassifications[tool as keyof typeof toolClassifications];
      expect(classification.kind, `${tool} classification`).not.toBe("local");

      // Assertions must live outside the responder: a tool's own try/catch
      // funnels any thrown error (including a failed `expect`) into a normal
      // `fail()` text result, so an in-responder assertion failure would
      // never surface as a failing test. Record the request, respond
      // unconditionally, then assert on what was actually recorded.
      const fixture = createStudioFetchFixture(() => responder());
      vi.stubGlobal("fetch", fixture.fetch);
      const { client } = await connectTestClient();
      try {
        const result = await client.callTool({ name: tool, arguments: args });
        const parsed = parseTextResult(result) as { error?: unknown };
        expect(parsed.error, `${tool} tool call succeeded (got ${JSON.stringify(parsed.error)})`).toBeUndefined();

        expect(fixture.requests.length, `${tool} recorded exactly one matching request`).toBeGreaterThanOrEqual(1);
        const recorded = fixture.requests[0];
        expect(recorded.method, `${tool} recorded method`).toBe(method);
        expect(recorded.url.pathname, `${tool} recorded pathname`).toBe(pathname);
        expect(recorded.url.pathname, `${tool} never leaks an internal route alias`).not.toContain("/api/agent/");
        if (tool === "create_workflow") {
          expect(recorded.body).toEqual({
            definition: expect.objectContaining({ name: "Contract test workflow" }),
          });
        }
      } finally {
        await client.close();
        vi.unstubAllGlobals();
      }
    }
  });

  it("create_workflow forwards runtimeVersion into the persisted definition instead of dropping it", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse({
        workflow: { id: "workflow-1", status: "development" },
        version: { id: "version-1", versionNumber: 1 },
      }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const called = parseTextResult(
        await client.callTool({
          name: "create_workflow",
          arguments: { name: "Pinned workflow", runtimeVersion: "1.2.3" },
        }),
      ) as { error?: unknown };
      expect(called.error).toBeUndefined();

      const recorded = fixture.requests[0];
      expect(recorded.method).toBe("POST");
      expect(recorded.body).toEqual({
        definition: expect.objectContaining({ name: "Pinned workflow", runtimeVersion: "1.2.3" }),
      });
    } finally {
      await client.close();
    }
  });

  it("get_workflow_schema forwards runtimeVersion as a query parameter and echoes Studio's response", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse({ schema: { type: "object" }, requestedRuntimeVersion: "1.2.3" }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const called = parseTextResult(
        await client.callTool({ name: "get_workflow_schema", arguments: { runtimeVersion: "1.2.3" } }),
      ) as { runtimeVersion?: string; jsonSchema?: unknown };
      expect(called.runtimeVersion).toBe("1.2.3");
      expect(called.jsonSchema).toEqual({ type: "object" });

      const recorded = fixture.requests[0];
      expect(recorded.method).toBe("GET");
      expect(recorded.url.searchParams.get("runtimeVersion")).toBe("1.2.3");
    } finally {
      await client.close();
    }
  });

  it("fixture-exercises every declared path of every multi-operation tool", async () => {
    const ids = {
      projectId: "11111111-1111-4111-8111-111111111111",
      workflowId: "workflow-1",
      versionId: "version-1",
      scheduleId: "schedule-1",
      sessionId: "session-1",
      resourceId: "22222222-2222-4222-8222-222222222222",
    };
    const definition = {
      name: "Workflow",
      settings: {},
      nodes: [{ type: "block", name: "Code", code: "return 1" }],
      edges: [],
    };
    const observed = new Map<string, Set<string>>();

    const normalizeOperation = (request: RecordedStudioRequest) => {
      let path = request.url.pathname;
      for (const [name, value] of Object.entries(ids)) {
        path = path.replaceAll(value, `{${name}}`);
      }
      return `${request.method} ${path}`;
    };

    const exercise = async (
      tool: keyof typeof toolClassifications,
      args: Record<string, unknown>,
      expected: readonly string[],
      responder: (request: RecordedStudioRequest) => Response,
    ) => {
      const fixture = createStudioFetchFixture(responder);
      vi.stubGlobal("fetch", fixture.fetch);
      const { client } = await connectTestClient({ projectId: ids.projectId });
      try {
        const called = parseTextResult(await client.callTool({ name: tool, arguments: args })) as {
          error?: unknown;
        };
        expect(called.error, `${tool} fixture result`).toBeUndefined();
      } finally {
        await client.close();
        vi.unstubAllGlobals();
      }

      const sequence = fixture.requests.map(normalizeOperation);
      expect(sequence, `${tool} operation sequence`).toEqual(expected);
      const classification = toolClassifications[tool];
      expect(classification.kind).not.toBe("local");
      if (classification.kind === "local") return;
      const declared = new Set<string>(classification.operations);
      for (const operation of sequence) {
        expect(declared.has(operation), `${tool} undeclared operation ${operation}`).toBe(true);
      }
      const toolObserved = observed.get(tool) ?? new Set<string>();
      for (const operation of sequence) toolObserved.add(operation);
      observed.set(tool, toolObserved);
    };

    await exercise(
      "copy_workflow",
      { workflowId: ids.workflowId, name: "Copy" },
      ["GET /api/v1/projects/{projectId}/workflows/{workflowId}", "POST /api/v1/projects/{projectId}/workflows"],
      (request) =>
        request.method === "GET"
          ? jsonResponse({
              workflow: {
                id: ids.workflowId,
                name: "Workflow",
                activeVersionId: ids.versionId,
                definition,
              },
            })
          : jsonResponse({ workflow: { id: "workflow-copy", name: "Copy" }, version: { id: "version-copy" } }),
    );

    for (const tool of ["edit_workflow", "edit_node_code"] as const) {
      await exercise(
        tool,
        tool === "edit_workflow"
          ? { workflowId: ids.workflowId, patch: { description: "Updated" } }
          : {
              workflowId: ids.workflowId,
              nodeName: "Code",
              oldString: "return 1",
              newString: "return 2",
            },
        [
          "GET /api/v1/projects/{projectId}/workflows/{workflowId}",
          "PUT /api/v1/projects/{projectId}/workflows/{workflowId}",
        ],
        (request) =>
          request.method === "GET"
            ? jsonResponse({
                workflow: {
                  id: ids.workflowId,
                  activeVersionId: ids.versionId,
                  definition,
                },
              })
            : jsonResponse({ version: { id: "version-2", versionNumber: 2 } }),
      );
    }

    await exercise(
      "revert_to_version",
      { workflowId: ids.workflowId, versionId: ids.versionId },
      [
        "GET /api/v1/projects/{projectId}/workflows/{workflowId}",
        "POST /api/v1/projects/{projectId}/workflows/{workflowId}/versions/{versionId}/revert",
      ],
      (request) =>
        request.method === "GET"
          ? jsonResponse({ workflow: { id: ids.workflowId, activeVersionId: "version-current" } })
          : jsonResponse({ version: { id: "version-2", versionNumber: 2 } }),
    );

    await exercise(
      "create_schedule",
      { workflowId: ids.workflowId, recurrenceRule: "FREQ=DAILY" },
      ["POST /api/v1/projects/{projectId}/workflows/{workflowId}/schedules"],
      () => jsonResponse({ schedule: { id: ids.scheduleId, status: "active" } }, { status: 201 }),
    );
    await exercise(
      "create_schedule",
      { workflowId: ids.workflowId, recurrenceRule: "FREQ=DAILY", enabled: false },
      [
        "POST /api/v1/projects/{projectId}/workflows/{workflowId}/schedules",
        "PATCH /api/v1/projects/{projectId}/workflows/{workflowId}/schedules/{scheduleId}",
        "GET /api/v1/projects/{projectId}/workflows/{workflowId}/schedules",
      ],
      (request) => {
        if (request.method === "POST") {
          return jsonResponse({ schedule: { id: ids.scheduleId, status: "active" } }, { status: 201 });
        }
        if (request.method === "PATCH") {
          return jsonResponse({ error: "upstream_failed", message: "Connection lost" }, { status: 502 });
        }
        return jsonResponse({
          schedules: [{ id: ids.scheduleId, status: "paused" }],
          currentPage: 1,
          totalPages: 1,
        });
      },
    );

    await exercise(
      "get_run",
      { sessionId: ids.sessionId, include: ["timeline", "io", "logs"] },
      [
        "GET /api/v1/projects/{projectId}/sessions/{sessionId}",
        "GET /api/v1/projects/{projectId}/sessions/{sessionId}/nodes",
        "GET /api/v1/projects/{projectId}/sessions/{sessionId}/logs",
      ],
      (request) => {
        if (request.url.pathname.endsWith("/nodes")) return jsonResponse({ nodes: [] });
        if (request.url.pathname.endsWith("/logs")) {
          return jsonResponse({ error: "not_found", message: "Logs unavailable" }, { status: 404 });
        }
        return jsonResponse({
          session: {
            id: ids.sessionId,
            workflowId: ids.workflowId,
            status: "completed",
          },
        });
      },
    );

    await exercise(
      "get_resource",
      { resourceId: ids.resourceId },
      ["GET /api/v1/projects/{projectId}/resources/{resourceId}"],
      () =>
        jsonResponse({
          resource: {
            id: ids.resourceId,
            name: "resource",
            value: {},
            lifecycle: "development",
          },
        }),
    );
    await exercise("get_resource", { name: "resource" }, ["GET /api/v1/projects/{projectId}/resources"], () =>
      jsonResponse({
        resources: [
          {
            id: ids.resourceId,
            name: "resource",
            value: {},
            lifecycle: "development",
          },
        ],
        currentPage: 1,
        totalPages: 1,
      }),
    );

    await exercise(
      "set_resource",
      { resourceId: ids.resourceId, value: { updated: true } },
      ["PUT /api/v1/projects/{projectId}/resources/{resourceId}"],
      () =>
        jsonResponse({
          resource: {
            id: ids.resourceId,
            name: "resource",
            value: { updated: true },
            lifecycle: "development",
          },
        }),
    );
    await exercise(
      "set_resource",
      { name: "new-resource", value: {} },
      ["GET /api/v1/projects/{projectId}/resources", "POST /api/v1/projects/{projectId}/resources"],
      (request) =>
        request.method === "GET"
          ? jsonResponse({ resources: [], currentPage: 1, totalPages: 1 })
          : jsonResponse(
              {
                resources: [
                  {
                    id: ids.resourceId,
                    name: "new-resource",
                    value: {},
                    lifecycle: "development",
                  },
                ],
              },
              { status: 201 },
            ),
    );

    await exercise(
      "delete_resource",
      { name: "resource" },
      ["GET /api/v1/projects/{projectId}/resources", "DELETE /api/v1/projects/{projectId}/resources/{resourceId}"],
      (request) =>
        request.method === "GET"
          ? jsonResponse({
              resources: [
                {
                  id: ids.resourceId,
                  name: "resource",
                  lifecycle: "development",
                },
              ],
              currentPage: 1,
              totalPages: 1,
            })
          : jsonResponse({ success: true }),
    );

    const multiOperationTools = Object.entries(toolClassifications)
      .filter(([, classification]) => classification.kind !== "local" && classification.operations.length > 1)
      .map(([tool]) => tool)
      .sort();
    expect([...observed.keys()].sort()).toEqual(multiOperationTools);
    for (const tool of multiOperationTools) {
      const classification = toolClassifications[tool as keyof typeof toolClassifications];
      if (classification.kind === "local") continue;
      expect(observed.get(tool)).toEqual(new Set(classification.operations));
    }
  });

  it("isolates remembered projects across concurrently interleaved logical connectors", async () => {
    const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fixture = createStudioFetchFixture((request) => {
      if (request.url.pathname === "/api/v1/projects") {
        return jsonResponse({
          projects: [
            { id: projectA, name: "A" },
            { id: projectB, name: "B" },
          ],
          currentPage: 1,
          totalPages: 1,
        });
      }
      return jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const [{ client: clientA }, { client: clientB }] = await Promise.all([
      connectTestClient({ projectId: null, connectionId: "connector-a" }),
      connectTestClient({ projectId: null, connectionId: "connector-b" }),
    ]);

    try {
      const selections = await Promise.all([
        clientA.callTool({ name: "set_project", arguments: { projectId: projectA } }),
        clientB.callTool({ name: "set_project", arguments: { projectId: projectB } }),
      ]);
      expect(selections.map(parseTextResult)).toEqual([
        { projectId: projectA, validated: true, selectionScope: "connector" },
        { projectId: projectB, validated: true, selectionScope: "connector" },
      ]);
      await Promise.all([
        clientB.callTool({ name: "list_workflows", arguments: {} }),
        clientA.callTool({ name: "list_workflows", arguments: {} }),
      ]);

      const workflowPaths = fixture.requests
        .map((request) => request.url.pathname)
        .filter((pathname) => pathname.endsWith("/workflows"));
      expect(workflowPaths).toEqual(
        expect.arrayContaining([`/api/v1/projects/${projectA}/workflows`, `/api/v1/projects/${projectB}/workflows`]),
      );
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
    }
  });

  it("falls back to PAT-global remembered project state when connector identity is absent", async () => {
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fixture = createStudioFetchFixture((request) => {
      if (request.url.pathname === "/api/v1/projects") {
        return jsonResponse({ projects: [{ id: projectId, name: "A" }], currentPage: 1, totalPages: 1 });
      }
      return jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    // No connectionId configured — this mirrors a real client that never
    // receives an Mcp-Session-Id, since this endpoint runs stateless.
    const { client } = await connectTestClient({ projectId: null });
    try {
      expect(parseTextResult(await client.callTool({ name: "set_project", arguments: { projectId } }))).toEqual({
        projectId,
        validated: true,
        selectionScope: "token",
        warning: TOKEN_SELECTION_WARNING,
      });

      await client.callTool({ name: "list_workflows", arguments: {} });
      const workflowRequest = fixture.requests.find((request) => request.url.pathname.endsWith("/workflows"));
      expect(workflowRequest?.url.pathname).toBe(`/api/v1/projects/${projectId}/workflows`);
    } finally {
      await client.close();
    }
  });

  it("characterizes last-writer-wins selection for bare callers sharing one PAT", async () => {
    const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fixture = createStudioFetchFixture((request) =>
      request.url.pathname === "/api/v1/projects"
        ? jsonResponse({
            projects: [
              { id: projectA, name: "A" },
              { id: projectB, name: "B" },
            ],
            currentPage: 1,
            totalPages: 1,
          })
        : jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client: first } = await connectTestClient({ projectId: null, apiKey: "pat_shared" });
    const { client: second } = await connectTestClient({ projectId: null, apiKey: "pat_shared" });
    try {
      await first.callTool({ name: "set_project", arguments: { projectId: projectA } });
      expect(
        parseTextResult(await second.callTool({ name: "set_project", arguments: { projectId: projectB } })),
      ).toEqual({
        projectId: projectB,
        validated: true,
        selectionScope: "token",
        warning: TOKEN_SELECTION_WARNING,
      });

      await first.callTool({ name: "list_workflows", arguments: {} });
      expect(fixture.requests.at(-1)?.url.pathname).toBe(`/api/v1/projects/${projectB}/workflows`);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("isolates connector-less remembered selections across unique PATs", async () => {
    const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fixture = createStudioFetchFixture((request) =>
      request.url.pathname === "/api/v1/projects"
        ? jsonResponse({
            projects: [
              { id: projectA, name: "A" },
              { id: projectB, name: "B" },
            ],
            currentPage: 1,
            totalPages: 1,
          })
        : jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client: clientA } = await connectTestClient({ projectId: null, apiKey: "pat_unique_a" });
    const { client: clientB } = await connectTestClient({ projectId: null, apiKey: "pat_unique_b" });
    try {
      await clientA.callTool({ name: "set_project", arguments: { projectId: projectA } });
      await clientB.callTool({ name: "set_project", arguments: { projectId: projectB } });
      await clientA.callTool({ name: "list_workflows", arguments: {} });
      await clientB.callTool({ name: "list_workflows", arguments: {} });

      const workflowPaths = fixture.requests
        .filter((request) => request.url.pathname.endsWith("/workflows"))
        .map((request) => request.url.pathname);
      expect(workflowPaths).toEqual([
        `/api/v1/projects/${projectA}/workflows`,
        `/api/v1/projects/${projectB}/workflows`,
      ]);
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
    }
  });

  it("applies project precedence query then header then remembered then default", async () => {
    const queryProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const headerProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const rememberedProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const defaultProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    vi.stubEnv("STUDIO_DEFAULT_PROJECT_ID", defaultProject);
    const fixture = createStudioFetchFixture((request) => {
      if (request.url.pathname === "/api/v1/projects") {
        return jsonResponse({
          projects: [{ id: rememberedProject, name: "Remembered" }],
          currentPage: 1,
          totalPages: 1,
        });
      }
      return jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);

    const { client: setter } = await connectTestClient({ projectId: null, connectionId: "precedence" });
    await setter.callTool({ name: "set_project", arguments: { projectId: rememberedProject } });
    await setter.close();

    const { client: queryClient } = await connectTestClient({
      projectId: queryProject,
      connectionId: "precedence",
      headers: { "x-project-id": headerProject },
    });
    await queryClient.callTool({ name: "list_workflows", arguments: {} });
    await queryClient.close();

    const { client: headerClient } = await connectTestClient({
      projectId: null,
      connectionId: "precedence",
      headers: { "x-project-id": headerProject },
    });
    await headerClient.callTool({ name: "list_workflows", arguments: {} });
    await headerClient.close();

    const { client: rememberedClient } = await connectTestClient({
      projectId: null,
      connectionId: "precedence",
    });
    await rememberedClient.callTool({ name: "list_workflows", arguments: {} });
    await rememberedClient.close();

    const { client: defaultClient } = await connectTestClient({
      projectId: null,
      connectionId: "new-connector",
    });
    await defaultClient.callTool({ name: "list_workflows", arguments: {} });
    await defaultClient.close();

    const workflowPaths = fixture.requests
      .map((request) => request.url.pathname)
      .filter((pathname) => pathname.endsWith("/workflows"));
    expect(workflowPaths).toEqual([
      `/api/v1/projects/${queryProject}/workflows`,
      `/api/v1/projects/${headerProject}/workflows`,
      `/api/v1/projects/${rememberedProject}/workflows`,
      `/api/v1/projects/${defaultProject}/workflows`,
    ]);
  });

  it("uses connector-scoped Redis keys and preserves project precedence", async () => {
    const queryProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const headerProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const rememberedProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const secondRememberedProject = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const defaultProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    vi.stubEnv("STUDIO_DEFAULT_PROJECT_ID", defaultProject);
    const redisFixture = createRedisFixture();
    __setRedisForTests(redisFixture.client);

    const fixture = createStudioFetchFixture((request) => {
      if (request.url.pathname === "/api/v1/projects") {
        return jsonResponse({
          projects: [
            { id: rememberedProject, name: "Remembered" },
            { id: secondRememberedProject, name: "Second" },
          ],
          currentPage: 1,
          totalPages: 1,
        });
      }
      return jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);

    const [{ client: setterA }, { client: setterB }] = await Promise.all([
      connectTestClient({ projectId: null, connectionId: "redis-a" }),
      connectTestClient({ projectId: null, connectionId: "redis-b" }),
    ]);
    await Promise.all([
      setterA.callTool({ name: "set_project", arguments: { projectId: rememberedProject } }),
      setterB.callTool({ name: "set_project", arguments: { projectId: secondRememberedProject } }),
    ]);
    await Promise.all([setterA.close(), setterB.close()]);

    const storedKeys = redisFixture.set.mock.calls.map(([key]) => key);
    expect(storedKeys).toHaveLength(2);
    expect(new Set(storedKeys).size).toBe(2);
    for (const key of storedKeys) {
      expect(key).toMatch(/^pat:project:[a-f0-9]{64}$/);
      expect(key).not.toContain("pat_test_fixture");
      expect(key).not.toContain("redis-");
    }

    const { client: queryClient } = await connectTestClient({
      projectId: queryProject,
      connectionId: "redis-a",
      headers: { "x-project-id": headerProject },
    });
    await queryClient.callTool({ name: "list_workflows", arguments: {} });
    await queryClient.close();

    const { client: headerClient } = await connectTestClient({
      projectId: null,
      connectionId: "redis-a",
      headers: { "x-project-id": headerProject },
    });
    await headerClient.callTool({ name: "list_workflows", arguments: {} });
    await headerClient.close();

    const { client: rememberedClient } = await connectTestClient({
      projectId: null,
      connectionId: "redis-a",
    });
    await rememberedClient.callTool({ name: "list_workflows", arguments: {} });
    await rememberedClient.close();

    const { client: secondRememberedClient } = await connectTestClient({
      projectId: null,
      connectionId: "redis-b",
    });
    await secondRememberedClient.callTool({ name: "list_workflows", arguments: {} });
    await secondRememberedClient.close();

    const { client: defaultClient } = await connectTestClient({
      projectId: null,
      connectionId: "redis-new",
    });
    await defaultClient.callTool({ name: "list_workflows", arguments: {} });
    await defaultClient.close();

    const workflowPaths = fixture.requests
      .map((request) => request.url.pathname)
      .filter((pathname) => pathname.endsWith("/workflows"));
    expect(workflowPaths).toEqual([
      `/api/v1/projects/${queryProject}/workflows`,
      `/api/v1/projects/${headerProject}/workflows`,
      `/api/v1/projects/${rememberedProject}/workflows`,
      `/api/v1/projects/${secondRememberedProject}/workflows`,
      `/api/v1/projects/${defaultProject}/workflows`,
    ]);
    expect(redisFixture.get).toHaveBeenCalledTimes(3);
  });

  it("falls back gracefully when a Redis remembered-project read fails", async () => {
    const defaultProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    vi.stubEnv("STUDIO_DEFAULT_PROJECT_ID", defaultProject);
    const get = vi.fn(async () => {
      throw new Error("deterministic Redis outage");
    });
    __setRedisForTests({
      get: get as RememberedProjectRedis["get"],
      set: vi.fn(async () => "OK"),
    });
    const fixture = createStudioFetchFixture(() => jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 }));
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient({ projectId: null, connectionId: "redis-failure" });
    try {
      const response = parseTextResult(await client.callTool({ name: "list_workflows", arguments: {} })) as {
        error?: unknown;
      };
      expect(response.error).toBeUndefined();
      expect(get).toHaveBeenCalledOnce();
      expect(fixture.requests[0]?.url.pathname).toBe(`/api/v1/projects/${defaultProject}/workflows`);
    } finally {
      await client.close();
    }
  });

  it("falls back per connector when a Redis remembered-project write fails", async () => {
    const selectedProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const defaultProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    vi.stubEnv("STUDIO_DEFAULT_PROJECT_ID", defaultProject);
    const get = vi.fn(async () => null);
    const set = vi.fn(async () => {
      throw new Error("deterministic Redis write outage");
    });
    __setRedisForTests({
      get: get as RememberedProjectRedis["get"],
      set,
    });
    const fixture = createStudioFetchFixture((request) => {
      if (request.url.pathname === "/api/v1/projects") {
        return jsonResponse({
          projects: [{ id: selectedProject, name: "Selected" }],
          currentPage: 1,
          totalPages: 1,
        });
      }
      return jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);

    const { client: setter } = await connectTestClient({
      projectId: null,
      connectionId: "redis-write-a",
    });
    expect(
      parseTextResult(
        await setter.callTool({
          name: "set_project",
          arguments: { projectId: selectedProject },
        }),
      ),
    ).toEqual({ projectId: selectedProject, validated: true, selectionScope: "connector" });
    await setter.close();

    const { client: selectedClient } = await connectTestClient({
      projectId: null,
      connectionId: "redis-write-a",
    });
    await selectedClient.callTool({ name: "list_workflows", arguments: {} });
    await selectedClient.close();

    const { client: otherConnector } = await connectTestClient({
      projectId: null,
      connectionId: "redis-write-b",
    });
    await otherConnector.callTool({ name: "list_workflows", arguments: {} });
    await otherConnector.close();

    expect(set).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(2);
    const workflowPaths = fixture.requests
      .map((request) => request.url.pathname)
      .filter((pathname) => pathname.endsWith("/workflows"));
    expect(workflowPaths).toEqual([
      `/api/v1/projects/${selectedProject}/workflows`,
      `/api/v1/projects/${defaultProject}/workflows`,
    ]);
  });

  it("mirrors successful Redis writes for later read-outage continuity", async () => {
    const selectedProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const defaultProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    vi.stubEnv("STUDIO_DEFAULT_PROJECT_ID", defaultProject);
    const redisFixture = createRedisFixture();
    __setRedisForTests(redisFixture.client);
    const fixture = createStudioFetchFixture((request) => {
      if (request.url.pathname === "/api/v1/projects") {
        return jsonResponse({
          projects: [{ id: selectedProject, name: "Selected" }],
          currentPage: 1,
          totalPages: 1,
        });
      }
      return jsonResponse({ workflows: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);

    const { client: setter } = await connectTestClient({
      projectId: null,
      connectionId: "redis-mirror-a",
    });
    expect(
      parseTextResult(
        await setter.callTool({
          name: "set_project",
          arguments: { projectId: selectedProject },
        }),
      ),
    ).toEqual({ projectId: selectedProject, validated: true, selectionScope: "connector" });
    await setter.close();
    expect(redisFixture.set).toHaveBeenCalledOnce();

    redisFixture.get.mockRejectedValue(new Error("deterministic Redis read outage"));

    const { client: selectedClient } = await connectTestClient({
      projectId: null,
      connectionId: "redis-mirror-a",
    });
    await selectedClient.callTool({ name: "list_workflows", arguments: {} });
    await selectedClient.close();

    const { client: otherConnector } = await connectTestClient({
      projectId: null,
      connectionId: "redis-mirror-b",
    });
    await otherConnector.callTool({ name: "list_workflows", arguments: {} });
    await otherConnector.close();

    expect(redisFixture.get).toHaveBeenCalledTimes(2);
    const workflowPaths = fixture.requests
      .map((request) => request.url.pathname)
      .filter((pathname) => pathname.endsWith("/workflows"));
    expect(workflowPaths).toEqual([
      `/api/v1/projects/${selectedProject}/workflows`,
      `/api/v1/projects/${defaultProject}/workflows`,
    ]);
  });

  it("aligns HITL list and completion with the current Studio v1 contract", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const taskId = "22222222-2222-4222-8222-222222222222";
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "GET") {
        return jsonResponse({
          tasks: [
            {
              id: taskId,
              sessionId,
              workflowId: "workflow-1",
              nodeName: "Approve",
              prompt: "Approve?",
              isApproval: true,
              selectedAction: "approve",
              status: "responded",
              createdAt: "2026-01-01T00:00:00Z",
              expiresAt: "2026-01-02T00:00:00Z",
              respondedAt: "2026-01-01T01:00:00Z",
              respondedByName: "Ada",
            },
          ],
          currentPage: 1,
          totalPages: 1,
        });
      }
      return jsonResponse({ success: true, taskId });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient({ projectId });
    try {
      const listed = parseTextResult(
        await client.callTool({
          name: "list_hitl_tasks",
          arguments: { sessionId, status: "responded" },
        }),
      );
      expect(listed).toEqual({
        items: [
          {
            taskId,
            sessionId,
            workflowId: "workflow-1",
            nodeName: "Approve",
            prompt: "Approve?",
            isApproval: true,
            selectedAction: "approve",
            status: "responded",
            createdAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-01-02T00:00:00Z",
            respondedAt: "2026-01-01T01:00:00Z",
            respondedByName: "Ada",
          },
        ],
        nextCursor: null,
      });

      expect(
        parseTextResult(
          await client.callTool({
            name: "complete_hitl_task",
            arguments: {
              taskId,
              action: "approve",
              fields: { owners: ["Ada", "Grace"], note: "ship" },
              secretKey: "tr_dev",
            },
          }),
        ),
      ).toEqual({ success: true });

      expect(fixture.requests[0]?.url.pathname).toBe(`/api/v1/projects/${projectId}/hitl/tasks`);
      expect(fixture.requests[0]?.url.searchParams.get("status")).toBe("responded");
      expect(fixture.requests[1]?.url.pathname).toBe(`/api/v1/projects/${projectId}/hitl/tasks/${taskId}/complete`);
      expect(fixture.requests[1]?.body).toEqual({
        action: "approve",
        fields: { owners: ["Ada", "Grace"], note: "ship" },
        secretKey: "tr_dev",
      });
    } finally {
      await client.close();
    }
  });

  it("forwards supported filters before Studio pagination", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse({ workflows: [], sessions: [], currentPage: 1, totalPages: 1 }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      await client.callTool({
        name: "list_workflows",
        arguments: { status: "active", search: "invoice" },
      });
      await client.callTool({
        name: "list_runs",
        arguments: {
          workflowId: "22222222-2222-4222-8222-222222222222",
          status: "failed",
        },
      });

      const workflowRequest = fixture.requests[0];
      const sessionRequest = fixture.requests[1];
      expect(workflowRequest).toBeDefined();
      expect(sessionRequest).toBeDefined();
      expect(Object.fromEntries(workflowRequest?.url.searchParams ?? [])).toMatchObject({
        status: "active",
        search: "invoice",
      });
      expect(Object.fromEntries(sessionRequest?.url.searchParams ?? [])).toMatchObject({
        workflowId: "22222222-2222-4222-8222-222222222222",
        status: "failed",
      });
    } finally {
      await client.close();
    }
  });

  it("scans resource pages for client-only search and exposes bounded continuation", async () => {
    const fixture = createStudioFetchFixture((request) => {
      const page = Number(request.url.searchParams.get("page"));
      return jsonResponse({
        resources:
          page === 2
            ? [
                {
                  id: "resource-2",
                  name: "invoice-template",
                  lifecycle: "development",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        currentPage: page,
        totalPages: 2,
      });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const page = parseTextResult(
        await client.callTool({
          name: "list_resources",
          arguments: { search: "invoice", limit: 25 },
        }),
      );
      expect(page).toMatchObject({
        items: [{ resourceId: "resource-2", name: "invoice-template" }],
        nextCursor: null,
        truncated: false,
      });
      expect(fixture.requests.map((request) => request.url.searchParams.get("page"))).toEqual(["1", "2"]);
    } finally {
      await client.close();
    }
  });

  it("returns a continuation cursor when resource search reaches its scan bound", async () => {
    const fixture = createStudioFetchFixture((request) => {
      const page = Number(request.url.searchParams.get("page"));
      return jsonResponse({ resources: [], currentPage: page, totalPages: 21 });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const page = parseTextResult(
        await client.callTool({
          name: "list_resources",
          arguments: { search: "not-present", limit: 25 },
        }),
      );
      expect(page).toMatchObject({
        items: [],
        nextCursor: expect.any(String),
        truncated: true,
      });
      expect(fixture.requests).toHaveLength(20);
    } finally {
      await client.close();
    }
  });

  it("preserves unique name-only resource reads and deletes", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const resourceId = "22222222-2222-4222-8222-222222222222";
    const resource = {
      id: resourceId,
      name: "invoice",
      value: { count: 1 },
      lifecycle: "development",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "DELETE") return jsonResponse({ success: true });
      if (request.url.pathname.endsWith(`/${resourceId}`)) {
        return jsonResponse({ resource });
      }
      return jsonResponse({
        resources: [resource],
        currentPage: 1,
        totalPages: 1,
      });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient({ projectId });
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "get_resource",
            arguments: { name: "invoice" },
          }),
        ),
      ).toMatchObject({ resourceId, name: "invoice", lifecycle: "development" });

      expect(
        parseTextResult(
          await client.callTool({
            name: "get_resource",
            arguments: { resourceId },
          }),
        ),
      ).toMatchObject({ resourceId, name: "invoice", lifecycle: "development" });

      expect(
        parseTextResult(
          await client.callTool({
            name: "delete_resource",
            arguments: { name: "invoice" },
          }),
        ),
      ).toEqual({ success: true, resourceId });

      expect(fixture.requests[0]?.url.searchParams.get("name")).toBe("invoice");
      expect(fixture.requests[0]?.url.searchParams.has("lifecycle")).toBe(false);
      expect(fixture.requests[1]?.url.pathname).toBe(`/api/v1/projects/${projectId}/resources/${resourceId}`);
      expect(fixture.requests[3]?.method).toBe("DELETE");
    } finally {
      await client.close();
    }
  });

  it("scans all bounded resource pages before rejecting an ambiguous name", async () => {
    const fixture = createStudioFetchFixture((request) => {
      const page = Number(request.url.searchParams.get("page"));
      return jsonResponse({
        resources: [
          {
            id: page === 1 ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
            name: "invoice",
            value: {},
            lifecycle: page === 1 ? "development" : "active",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        currentPage: page,
        totalPages: 2,
      });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "get_resource",
            arguments: { name: "invoice" },
          }),
        ),
      ).toEqual({
        error: {
          code: "conflict",
          status: 409,
          message: 'Resource name "invoice" exists in multiple lifecycles; provide lifecycle or resourceId.',
        },
      });
      expect(fixture.requests.map((request) => request.url.searchParams.get("page"))).toEqual(["1", "2"]);
    } finally {
      await client.close();
    }
  });

  it("normalizes resourceId updates and zero-match name-only creates", async () => {
    const updatedId = "22222222-2222-4222-8222-222222222222";
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "PUT") {
        return jsonResponse({
          resource: {
            id: updatedId,
            name: "invoice",
            value: { count: 2 },
            lifecycle: "development",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        });
      }
      if (request.method === "POST") {
        return jsonResponse(
          {
            resources: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                name: "new-resource",
                value: {},
                lifecycle: "development",
                updatedAt: "2026-01-01T00:00:00Z",
              },
              {
                id: "44444444-4444-4444-8444-444444444444",
                name: "new-resource",
                value: {},
                lifecycle: "active",
                updatedAt: "2026-01-01T00:00:00Z",
              },
            ],
          },
          { status: 201 },
        );
      }
      return jsonResponse({ resources: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "set_resource",
            arguments: { resourceId: updatedId, value: { count: 2 } },
          }),
        ),
      ).toMatchObject({
        resource: { resourceId: updatedId, name: "invoice", lifecycle: "development" },
      });

      expect(
        parseTextResult(
          await client.callTool({
            name: "set_resource",
            arguments: { name: "new-resource", value: {} },
          }),
        ),
      ).toMatchObject({
        resources: [
          {
            resourceId: "33333333-3333-4333-8333-333333333333",
            lifecycle: "development",
          },
          {
            resourceId: "44444444-4444-4444-8444-444444444444",
            lifecycle: "active",
          },
        ],
      });
    } finally {
      await client.close();
    }
  });

  it("maps manual, API, and workflow resource writes to the revision-2 contract", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const apiId = "22222222-2222-4222-8222-222222222222";
    const workflowId = "33333333-3333-4333-8333-333333333333";
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "GET") {
        return jsonResponse({ resources: [], currentPage: 1, totalPages: 1 });
      }
      if (request.method === "DELETE") return jsonResponse({ success: true });
      const body = request.body as Record<string, unknown>;
      const source = (body.source as string | undefined) ?? "manual";
      const id = source === "workflow" ? workflowId : apiId;
      const resource = {
        id,
        name: source === "api" ? "exchange-rates" : "workflow-cache",
        description: body.description ?? null,
        value: body.value,
        source,
        config: source === "api" ? body.config : null,
        lifecycle: "development",
        lastFetchedAt: source === "api" ? "2026-07-24T10:00:00Z" : null,
        createdAt: "2026-07-24T09:00:00Z",
        updatedAt: "2026-07-24T10:00:00Z",
      };
      return jsonResponse(request.method === "POST" ? { resources: [resource] } : { resource }, {
        status: request.method === "POST" ? 201 : 200,
      });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient({ projectId });
    try {
      await client.callTool({
        name: "set_resource",
        arguments: { name: "legacy-manual", value: { enabled: true } },
      });
      expect(fixture.requests[1]?.body).toEqual({
        name: "legacy-manual",
        value: { enabled: true },
        source: "manual",
      });

      const apiResult = parseTextResult(
        await client.callTool({
          name: "set_resource",
          arguments: {
            name: "exchange-rates",
            lifecycle: "development",
            value: { USD: 1 },
            source: "api",
            config: { url: "https://example.com/rates", schedule: "0 * * * *" },
            description: "Hourly rates",
          },
        }),
      );
      expect(fixture.requests[3]?.body).toEqual({
        name: "exchange-rates",
        value: { USD: 1 },
        source: "api",
        config: { url: "https://example.com/rates", schedule: "0 * * * *" },
        description: "Hourly rates",
        lifecycle: "development",
      });
      expect(apiResult).toEqual({
        resources: [
          {
            resourceId: apiId,
            name: "exchange-rates",
            kind: "data",
            description: "Hourly rates",
            value: { USD: 1 },
            source: "api",
            config: { url: "https://example.com/rates", schedule: "0 * * * *" },
            lifecycle: "development",
            lastFetchedAt: "2026-07-24T10:00:00Z",
            createdAt: "2026-07-24T09:00:00Z",
            updatedAt: "2026-07-24T10:00:00Z",
          },
        ],
      });

      await client.callTool({
        name: "set_resource",
        arguments: {
          resourceId: workflowId,
          value: { cursor: 2 },
          source: "workflow",
          description: null,
        },
      });
      expect(fixture.requests[4]?.body).toEqual({
        value: { cursor: 2 },
        source: "workflow",
        description: null,
      });

      await client.callTool({ name: "delete_resource", arguments: { resourceId: apiId } });
      expect(fixture.requests[5]).toMatchObject({ method: "DELETE" });
      expect(fixture.requests[5]?.url.pathname).toBe(`/api/v1/projects/${projectId}/resources/${apiId}`);
    } finally {
      await client.close();
    }
  });

  it("passes source/config combinations to Studio and sanitizes resource failures", async () => {
    const leakedValue = "customer-value-must-not-leak";
    const fixture = createStudioFetchFixture(() =>
      jsonResponse(
        {
          error: "resource_invalid_config",
          message: "Resource configuration is invalid.",
        },
        { status: 400 },
      ),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const response = parseTextResult(
        await client.callTool({
          name: "set_resource",
          arguments: {
            resourceId: "22222222-2222-4222-8222-222222222222",
            value: leakedValue,
            source: "manual",
            config: { url: "https://example.com/data" },
          },
        }),
      );
      expect(fixture.requests[0]?.body).toEqual({
        value: leakedValue,
        source: "manual",
        config: { url: "https://example.com/data" },
      });
      expect(response).toMatchObject({
        error: { code: "resource_invalid_config", status: 400, message: "Resource configuration is invalid." },
      });
      expect(JSON.stringify(response)).not.toContain(leakedValue);
    } finally {
      await client.close();
    }
  });

  it("tests an external resource API without persistence", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const fixture = createStudioFetchFixture(() => jsonResponse({ value: { ok: true } }));
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient({ projectId });
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "test_resource_api",
            arguments: { url: "https://example.com/data.json" },
          }),
        ),
      ).toEqual({ value: { ok: true } });
      expect(fixture.requests[0]).toMatchObject({
        method: "POST",
        body: { url: "https://example.com/data.json" },
      });
      expect(fixture.requests[0]?.url.pathname).toBe(`/api/v1/projects/${projectId}/resources/test-fetch`);
    } finally {
      await client.close();
    }
  });

  it("fails closed when Studio returns success without the expected resource payload", async () => {
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "PUT") return jsonResponse({});
      if (request.method === "POST") return jsonResponse({});
      return jsonResponse({ resources: [], currentPage: 1, totalPages: 1 });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "set_resource",
            arguments: { resourceId: "22222222-2222-4222-8222-222222222222", value: { count: 2 } },
          }),
        ),
      ).toEqual({
        error: {
          code: "internal_error",
          status: 502,
          message: "Studio returned a success status without the updated resource.",
        },
      });

      expect(
        parseTextResult(
          await client.callTool({
            name: "set_resource",
            arguments: { name: "brand-new-resource", value: {} },
          }),
        ),
      ).toEqual({
        error: {
          code: "internal_error",
          status: 502,
          message: "Studio returned a success status without any created resources.",
        },
      });
    } finally {
      await client.close();
    }
  });

  it("updates the unique row found by a name-only set_resource lookup", async () => {
    const resourceId = "22222222-2222-4222-8222-222222222222";
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "GET") {
        return jsonResponse({
          resources: [
            {
              id: resourceId,
              name: "invoice",
              value: { count: 1 },
              lifecycle: "development",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          currentPage: 1,
          totalPages: 1,
        });
      }
      return jsonResponse({
        resource: {
          id: resourceId,
          name: "invoice",
          value: { count: 2 },
          lifecycle: "development",
          updatedAt: "2026-01-01T00:01:00Z",
        },
      });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "set_resource",
            arguments: { name: "invoice", value: { count: 2 } },
          }),
        ),
      ).toMatchObject({
        resource: { resourceId, name: "invoice", lifecycle: "development" },
      });
      expect(fixture.requests.map((request) => request.method)).toEqual(["GET", "PUT"]);
      expect(fixture.requests[1]?.url.pathname).toContain(`/resources/${resourceId}`);
    } finally {
      await client.close();
    }
  });

  it("returns conflict when name-only set_resource matches multiple lifecycle rows", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse({
        resources: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "invoice",
            lifecycle: "development",
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "invoice",
            lifecycle: "active",
          },
        ],
        currentPage: 1,
        totalPages: 1,
      }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "set_resource",
            arguments: { name: "invoice", value: {} },
          }),
        ),
      ).toEqual({
        error: {
          code: "conflict",
          status: 409,
          message: 'Resource name "invoice" exists in multiple lifecycles; provide lifecycle or resourceId.',
        },
      });
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("updates a unique name-only resource found on a later page", async () => {
    const resourceId = "22222222-2222-4222-8222-222222222222";
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "PUT") {
        return jsonResponse({
          resource: {
            id: resourceId,
            name: "invoice",
            value: { count: 2 },
            lifecycle: "active",
            updatedAt: "2026-01-01T00:01:00Z",
          },
        });
      }
      const page = Number(request.url.searchParams.get("page"));
      return jsonResponse({
        resources:
          page === 2
            ? [
                {
                  id: resourceId,
                  name: "invoice",
                  value: { count: 1 },
                  lifecycle: "active",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              ]
            : [],
        currentPage: page,
        totalPages: 2,
      });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "set_resource",
            arguments: { name: "invoice", value: { count: 2 } },
          }),
        ),
      ).toMatchObject({
        resource: { resourceId, lifecycle: "active" },
      });
      expect(fixture.requests.map((request) => request.method)).toEqual(["GET", "GET", "PUT"]);
      expect(fixture.requests.slice(0, 2).map((request) => request.url.searchParams.get("page"))).toEqual(["1", "2"]);
    } finally {
      await client.close();
    }
  });

  it("returns an unknown pause outcome when schedule reconciliation also fails", async () => {
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "POST") {
        return jsonResponse({ schedule: { id: "schedule-1", status: "active" } }, { status: 201 });
      }
      return jsonResponse({ error: "upstream_failed", message: "Pause failed" }, { status: 502 });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "create_schedule",
            arguments: {
              workflowId: "workflow-1",
              recurrenceRule: "FREQ=DAILY",
              enabled: false,
            },
          }),
        ),
      ).toEqual({
        error: { code: "internal_error", status: 502, message: "Studio request failed." },
        partialResult: {
          scheduleId: "schedule-1",
          created: true,
          previousStatus: "active",
          pauseOutcome: "unknown",
          requestedStatus: "paused",
        },
      });
      expect(fixture.requests.map((request) => request.method)).toEqual(["POST", "PATCH", "GET"]);
    } finally {
      await client.close();
    }
  });

  it("reconciles a schedule pause that applied before the error response", async () => {
    const fixture = createStudioFetchFixture((request) => {
      if (request.method === "POST") {
        return jsonResponse({ schedule: { id: "schedule-1", status: "active" } }, { status: 201 });
      }
      if (request.method === "PATCH") {
        return jsonResponse({ error: "upstream_failed", message: "Connection lost" }, { status: 502 });
      }
      return jsonResponse({ schedules: [{ id: "schedule-1", status: "paused" }] });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "create_schedule",
            arguments: {
              workflowId: "workflow-1",
              recurrenceRule: "FREQ=DAILY",
              enabled: false,
            },
          }),
        ),
      ).toEqual({
        scheduleId: "schedule-1",
        status: "paused",
        reconciled: true,
      });
      expect(fixture.requests.map((request) => request.method)).toEqual(["POST", "PATCH", "GET"]);
      expect(Object.fromEntries(fixture.requests[2]?.url.searchParams ?? [])).toEqual({
        page: "1",
        pageSize: "200",
      });
    } finally {
      await client.close();
    }
  });

  it("reports completed and pending keys when a secret batch partially fails", async () => {
    const fixture = createStudioFetchFixture((request) =>
      request.url.pathname.endsWith("/FIRST")
        ? jsonResponse({ success: true })
        : jsonResponse({ error: "upstream_failed", message: "Second write failed" }, { status: 502 }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "set_secrets",
            arguments: {
              dopplerProject: "proj",
              dopplerConfig: "dev",
              secrets: [
                { key: "FIRST", value: "one" },
                { key: "SECOND", value: "two" },
                { key: "THIRD", value: "three" },
              ],
            },
          }),
        ),
      ).toEqual({
        error: { code: "internal_error", status: 502, message: "Studio request failed." },
        partialResult: {
          updated: ["FIRST"],
          attemptedKey: "SECOND",
          outcome: "unknown",
          remainingKeys: ["THIRD"],
        },
      });
      expect(fixture.requests).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("uses the shared characterized failure envelope for local patch failures", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse({
        workflow: {
          id: "workflow-1",
          activeVersionId: "22222222-2222-4222-8222-222222222222",
          definition: { name: "Test", settings: {}, nodes: [], edges: [] },
        },
      }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      expect(
        parseTextResult(
          await client.callTool({
            name: "edit_workflow",
            arguments: {
              workflowId: "workflow-1",
              patch: { nodes: { remove: ["Missing"] } },
            },
          }),
        ),
      ).toEqual({
        error: {
          code: "validation_failed",
          status: 422,
          message: "Cannot remove unknown node(s): Missing. Nodes: ",
        },
      });
    } finally {
      await client.close();
    }
  });
});

import { describe, expect, it } from "vitest";
import { connectTestClient } from "../helpers/mcp-harness.js";

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
  get_resource: { kind: "studio", operations: ["GET /api/v1/projects/{projectId}/resources"] },
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
  list_extractors: { kind: "studio", operations: ["GET /api/v1/projects/{projectId}/extractors"] },
  get_extractor: {
    kind: "studio",
    operations: ["GET /api/v1/projects/{projectId}/extractors/{extractorId}"],
  },
} as const satisfies Record<string, ToolClassification>;

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

  it.todo("binds remembered project selections to an unambiguous connection identity");
  it.todo("aligns HITL status, action, field, and completion contracts with Studio v1");
  it.todo("delegates list filtering and pagination semantics to Studio consistently");
});

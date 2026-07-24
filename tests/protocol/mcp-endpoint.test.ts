import { afterEach, describe, expect, it, vi } from "vitest";
import { OPTIONS, POST } from "../../api/mcp.js";
import packageJson from "../../package.json" with { type: "json" };
import { connectTestClient, createStudioFetchFixture, jsonResponse, parseTextResult } from "../helpers/mcp-harness.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Streamable HTTP MCP endpoint", () => {
  it("initializes through the exported Vercel handler and reports the package version", async () => {
    const { client } = await connectTestClient();
    try {
      expect(client.getServerVersion()).toEqual({
        name: "automat-robotic-workflows",
        version: packageJson.version,
      });
      expect(client.getServerCapabilities()?.tools).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it("lists tools and calls a local tool without contacting Studio", async () => {
    const studioFetch = vi.fn();
    vi.stubGlobal("fetch", studioFetch);
    const { client } = await connectTestClient();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("get_docs");

      const called = await client.callTool({ name: "get_docs", arguments: { topic: "lifecycle" } });
      expect(parseTextResult(called)).toMatchObject({
        lifecycle: {
          policy: expect.stringContaining("rollout ladder"),
          development: expect.stringContaining("not a platform-enforced side-effect sandbox"),
        },
      });
      const codeDocs = parseTextResult(await client.callTool({ name: "get_docs", arguments: { topic: "codeNodes" } }));
      expect(codeDocs).toMatchObject({
        codeNodes: {
          globals: {
            files: expect.stringContaining("files.download"),
            "emit, state": expect.stringContaining("state"),
          },
        },
      });
      expect(studioFetch).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("returns protocol errors for invalid input and unknown tools", async () => {
    const { client } = await connectTestClient();
    try {
      const invalid = await client.callTool({
        name: "get_docs",
        arguments: { topic: "not-a-topic" },
      });
      expect(invalid).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Input validation error") }],
      });

      const unknown = await client.callTool({ name: "not_a_registered_tool", arguments: {} });
      expect(unknown).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("not_a_registered_tool") }],
      });
    } finally {
      await client.close();
    }
  });

  it("advertises CORS for every accepted connection header", async () => {
    const response = OPTIONS();

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    const allowedHeaders = response.headers.get("access-control-allow-headers") ?? "";
    for (const header of [
      "authorization",
      "x-api-key",
      "x-project-id",
      "x-connection-id",
      "mcp-session-id",
      "mcp-protocol-version",
    ]) {
      expect(allowedHeaders).toContain(header);
    }
  });

  it("adds CORS headers to unauthenticated responses", async () => {
    const response = await POST(
      new Request("https://mcp.test/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("adds CORS headers to successful protocol responses", async () => {
    const response = await POST(
      new Request("https://mcp.test/api/mcp?api_key=pat_test_fixture", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "cors-contract-test", version: "1.0.0" },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("records Studio requests and preserves current text-result semantics", async () => {
    const fixture = createStudioFetchFixture((request) => {
      expect(request.method).toBe("GET");
      expect(request.url.pathname).toBe("/api/v1/projects");
      expect(request.url.searchParams.get("page")).toBe("1");
      expect(request.url.searchParams.get("pageSize")).toBe("25");
      expect(request.headers.get("authorization")).toBe("Bearer pat_test_fixture");
      expect(request.body).toBeUndefined();
      return jsonResponse({
        projects: [{ id: "project-1", name: "Test project" }],
        currentPage: 1,
        totalPages: 1,
      });
    });
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const called = await client.callTool({ name: "list_projects", arguments: {} });

      expect(parseTextResult(called)).toEqual({
        items: [{ projectId: "project-1", name: "Test project" }],
        nextCursor: null,
        projectSelection: {
          explicit:
            "Safest: send project_id on the URL or x-project-id on every call; explicit selectors take precedence.",
          connector:
            "For remembered selection, call set_project with connection_id, x-connection-id, or a client-supplied mcp-session-id.",
          tokenCaveat:
            "Without connector identity, set_project uses token scope and all callers sharing this PAT share one selection.",
        },
      });
      expect(called).not.toHaveProperty("structuredContent");
      expect(called).not.toHaveProperty("isError");
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("keeps Studio failures in the characterized text error envelope", async () => {
    const fixture = createStudioFetchFixture(() =>
      jsonResponse({ error: "forbidden", message: "Read tier only" }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fixture.fetch);
    const { client } = await connectTestClient();
    try {
      const called = await client.callTool({ name: "get_workflow_schema", arguments: {} });

      expect(parseTextResult(called)).toEqual({
        error: { code: "forbidden", status: 403, message: "Read tier only" },
      });
      expect(called).not.toHaveProperty("isError");
    } finally {
      await client.close();
    }
  });
});

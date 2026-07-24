import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DELETE, GET, POST } from "../../api/mcp.js";

export interface RecordedStudioRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type StudioResponder = (request: RecordedStudioRequest) => Response | Promise<Response>;

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

export function createStudioFetchFixture(responder: StudioResponder) {
  const requests: RecordedStudioRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    let body: unknown = rawBody;
    if (typeof rawBody === "string" && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const request = {
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      url,
      headers,
      body,
    };
    requests.push(request);
    return responder(request);
  };

  return { fetch, requests };
}

async function invokeVercelHandler(input: string | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  switch (request.method) {
    case "GET":
      return GET(request);
    case "POST":
      return POST(request);
    case "DELETE":
      return DELETE(request);
    default:
      return new Response("Method not allowed", { status: 405 });
  }
}

export async function connectTestClient(
  options: { apiKey?: string; projectId?: string | null; connectionId?: string; headers?: Record<string, string> } = {},
) {
  const client = new Client({ name: "repository-contract-tests", version: "1.0.0" });
  const url = new URL("https://mcp.test/api/mcp");
  url.searchParams.set("api_key", options.apiKey ?? "pat_test_fixture");
  if (options.projectId !== null) {
    url.searchParams.set("project_id", options.projectId ?? "11111111-1111-4111-8111-111111111111");
  }
  if (options.connectionId) url.searchParams.set("connection_id", options.connectionId);
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(options.headers ?? {})) {
        headers.set(name, value);
      }
      return invokeVercelHandler(input, {
        ...init,
        headers,
      });
    },
  });
  await client.connect(transport);
  return { client, transport };
}

export function parseTextResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("Expected an immediate MCP tool result.");
  }
  const text = result.content.find(
    (entry): entry is { type: "text"; text: string } =>
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "text" &&
      "text" in entry &&
      typeof entry.text === "string",
  );
  if (!text) throw new Error("Expected a text MCP tool result.");
  return JSON.parse(text.text);
}

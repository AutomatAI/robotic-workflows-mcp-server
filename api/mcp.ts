import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

/**
 * Automat Robotic Workflows MCP Server — v1 ("hello world").
 *
 * Single stateless Streamable-HTTP endpoint deployed as a plain Vercel Function.
 * Exposes a couple of dummy tools (`ping`, `echo`) to prove the auth + deploy +
 * connectivity scaffolding. Real workflow tools (CRUD, run/monitor) come later.
 */

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// v1 uses a single shared static API key. It is hardcoded as a default so the
// server deploys with zero env config, but can be overridden via the
// MCP_API_KEY env var in Vercel.
//
// ⚠️  This is a throwaway demo key guarding dummy tools only. Rotate it before
//     wiring up real workflow tools by setting MCP_API_KEY in the Vercel project
//     env (Production + Preview) — the env var takes precedence over this default.
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

/**
 * Extract the API key from (in priority order):
 *   1. ?api_key= query param   → the only option that works in the Claude app
 *                                connector UI, which has no header field.
 *   2. x-api-key header
 *   3. Authorization: Bearer <key> header  → clean path for Claude Code CLI.
 */
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
// MCP server + tools
// ---------------------------------------------------------------------------
const baseHandler = createMcpHandler(
  (server) => {
    server.tool(
      "ping",
      "Health check for the Automat workflows MCP server. Returns 'pong' plus the current server time. Use this to confirm the connection is live.",
      {},
      async () => ({
        content: [
          { type: "text", text: `pong @ ${new Date().toISOString()}` },
        ],
      }),
    );

    server.tool(
      "echo",
      "Echo a message back. A simple connectivity / round-trip test that confirms tool arguments are passed correctly.",
      { message: z.string().describe("Text to echo back") },
      async ({ message }) => ({
        content: [{ type: "text", text: `You said: ${message}` }],
      }),
    );
  },
  {
    // Server metadata + instructions (used by tool-search-enabled clients).
    serverInfo: { name: "automat-robotic-workflows", version: "0.1.0" },
    instructions:
      "Automat Robotic Workflows MCP server. v1 exposes dummy connectivity tools (ping, echo). " +
      "Future versions will expose tools to build, deploy, run and monitor RPA workflows.",
  },
  {
    // Must match where this route lives (api/mcp.ts → /api). The clean public
    // path /mcp is rewritten to /api/mcp in vercel.json.
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  },
);

// ---------------------------------------------------------------------------
// Auth-wrapped handler exports (Vercel Function: one file, all methods)
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

const handleOptions = (): Response =>
  new Response(null, { status: 204, headers: corsHeaders });

export {
  authed as GET,
  authed as POST,
  authed as DELETE,
  handleOptions as OPTIONS,
};

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  listLists,
  getItems,
  addItem,
  completeItem,
  uncompleteItem,
  deleteItem,
} from "./reminders.js";
import { log } from "./log.js";

const PORT = parseInt(process.env.MCP_REMINDERS_PORT || "18800", 10);
const BIND = process.env.MCP_REMINDERS_BIND || "0.0.0.0";
const TOKEN = process.env.MCP_REMINDERS_TOKEN || "";
const CERT_DIR = process.env.MCP_REMINDERS_CERT_DIR || join(process.cwd(), "certs");

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "mcp-reminder",
    version: "1.0.0",
  });

  server.tool(
    "reminders_list_lists",
    "List all Apple Reminders lists with item counts",
    {},
    async () => {
      const lists = await listLists();
      return { content: [{ type: "text", text: JSON.stringify(lists) }] };
    }
  );

  server.tool(
    "reminders_get_items",
    "Get reminders from a specific list",
    {
      list: z.string().describe("Name of the Reminders list"),
      include_completed: z
        .boolean()
        .default(false)
        .describe("Include completed reminders"),
    },
    async ({ list, include_completed }) => {
      const items = await getItems(list, include_completed);
      return { content: [{ type: "text", text: JSON.stringify(items) }] };
    }
  );

  server.tool(
    "reminders_add_item",
    "Add a new reminder to a list",
    {
      list: z.string().describe("Name of the Reminders list"),
      name: z.string().describe("Reminder title"),
      notes: z.string().optional().describe("Optional notes/body"),
      due_date: z
        .string()
        .optional()
        .describe("Optional due date in ISO 8601 format"),
    },
    async ({ list, name, notes, due_date }) => {
      const item = await addItem(list, name, { notes, dueDate: due_date });
      return { content: [{ type: "text", text: JSON.stringify(item) }] };
    }
  );

  server.tool(
    "reminders_complete_item",
    "Mark a reminder as completed",
    {
      list: z.string().describe("Name of the Reminders list"),
      item_id: z.string().describe("ID of the reminder to complete"),
    },
    async ({ list, item_id }) => {
      const result = await completeItem(list, item_id);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "reminders_uncomplete_item",
    "Mark a completed reminder as not completed",
    {
      list: z.string().describe("Name of the Reminders list"),
      item_id: z.string().describe("ID of the reminder to uncomplete"),
    },
    async ({ list, item_id }) => {
      const result = await uncompleteItem(list, item_id);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.tool(
    "reminders_delete_item",
    "Delete a reminder from a list",
    {
      list: z.string().describe("Name of the Reminders list"),
      item_id: z.string().describe("ID of the reminder to delete"),
    },
    async ({ list, item_id }) => {
      const result = await deleteItem(list, item_id);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  return server;
}

const transports = new Map<string, StreamableHTTPServerTransport>();

const hasTls = existsSync(join(CERT_DIR, "cert.pem")) && existsSync(join(CERT_DIR, "key.pem"));
const requestHandler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
  const proto = hasTls ? "https" : "http";
  const url = new URL(req.url || "/", `${proto}://${req.headers.host}`);

  // Health check
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "mcp-reminder", version: "1.0.0" }));
    return;
  }

  // Only handle /mcp
  if (url.pathname !== "/mcp") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Token auth — accept via header or query parameter
  if (TOKEN) {
    const headerToken = req.headers.authorization === `Bearer ${TOKEN}`;
    const queryToken = url.searchParams.get("token") === TOKEN;
    if (!headerToken && !queryToken) {
      log.warn(`auth rejected from ${req.socket.remoteAddress}`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "GET" || req.method === "DELETE") {
    if (!sessionId || !transports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session" }));
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    if (req.method === "DELETE") {
      transports.delete(sessionId);
    }
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  // POST — existing session
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId)!.handleRequest(req, res);
    return;
  }

  // POST — new session
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      log.info(`session created: ${id}`);
      transports.set(id, transport);
    },
  });

  transport.onclose = () => {
    const id = [...transports.entries()].find(([, t]) => t === transport)?.[0];
    if (id) {
      log.info(`session closed: ${id}`);
      transports.delete(id);
    }
  };

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
};

const httpServer = hasTls
  ? createHttpsServer(
      {
        key: readFileSync(join(CERT_DIR, "key.pem")),
        cert: readFileSync(join(CERT_DIR, "cert.pem")),
      },
      requestHandler,
    )
  : createHttpServer(requestHandler);

const proto = hasTls ? "https" : "http";
httpServer.listen(PORT, BIND, () => {
  const msg = `mcp-reminder listening on ${proto}://${BIND}:${PORT}/mcp`;
  console.log(msg);
  log.info(msg);
  log.info(`health check: ${proto}://${BIND}:${PORT}/health`);
  if (hasTls) {
    log.info(`TLS enabled (cert: ${CERT_DIR})`);
  }
  if (!TOKEN) {
    const warn = "No MCP_REMINDERS_TOKEN set — running without auth";
    console.warn("WARNING: " + warn);
    log.warn(warn);
  }
});

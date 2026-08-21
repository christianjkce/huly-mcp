#!/usr/bin/env node

// The local HTTP daemon uses the MCP SDK's stateless legacy mode: each POST
// returns one SSE response and then closes. Do not use a stateful client
// transport here; it interprets that normal response boundary as a session
// close. This bridge keeps the CLI-facing STDIO stream open and forwards one
// JSON-RPC message per HTTP request.

const { createInterface } = require("readline");

const endpoint = "http://127.0.0.1:8088/mcp";
const headers = {
  "accept": "application/json, text/event-stream",
  "content-type": "application/json",
};
if (process.env.HULY_TOKEN) {
  headers["authorization"] = `Bearer ${process.env.HULY_TOKEN}`;
  headers["x-huly-token"] = process.env.HULY_TOKEN;
}
if (process.env.HULY_WORKSPACE) headers["x-huly-workspace"] = process.env.HULY_WORKSPACE;
if (process.env.HULY_URL) headers["x-huly-url"] = process.env.HULY_URL;

const jsonRpcError = (id, code, message) =>
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function forward(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(jsonRpcError(null, -32700, "Parse error") + "\n");
    return;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
    const body = await response.text();
    if (!response.ok) {
      process.stdout.write(jsonRpcError(request.id, -32000, `HTTP ${response.status}`) + "\n");
      return;
    }

    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
      : [body.trim()];
    for (const message of messages) {
      if (message && message !== "[DONE]") process.stdout.write(message + "\n");
    }
  } catch (error) {
    process.stdout.write(jsonRpcError(request.id, -32603, `Huly MCP unavailable: ${error.name}`) + "\n");
  }
}

let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim()) queue = queue.then(() => forward(line));
});
rl.on("close", () => {
  queue.catch(() => {}).finally(() => process.exit(0));
});

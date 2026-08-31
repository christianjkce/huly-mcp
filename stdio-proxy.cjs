#!/usr/bin/env node

// The local HTTP daemon uses the MCP SDK's stateless legacy mode: each POST
// returns one SSE response and then closes. Do not use a stateful client
// transport here; it interprets that normal response boundary as a session
// close. This bridge keeps the CLI-facing STDIO stream open and forwards one
// JSON-RPC message per HTTP request.

const { createInterface } = require("readline");

const endpoint = process.env.HULY_MCP_HTTP_ENDPOINT || "http://127.0.0.1:8088/mcp";
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
if (process.env.HULY_IDENTITY) headers["x-huly-agent"] = process.env.HULY_IDENTITY;

const jsonRpcError = (id, code, message) =>
  JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// OPS-55: Der Aufrufer bekam frueher nur "Huly MCP unavailable: TypeError".
// Das entstand hier: `error.message || error.name` faellt auf den Klassennamen
// zurueck, sobald die Meldung leer ist — und `fetch` legt den eigentlichen Grund
// (ECONNREFUSED, ENOTFOUND, socket hang up) ausschliesslich in `error.cause` ab.
// Genau die Angabe, die man zum Handeln braucht, wurde also weggeworfen.
const describeError = (error) => {
  const teile = [];
  let aktuell = error;
  for (let tiefe = 0; aktuell && tiefe < 5; tiefe += 1) {
    const name = aktuell.name || aktuell.constructor?.name || "Error";
    const code = aktuell.code ? ` (${aktuell.code})` : "";
    const meldung = aktuell.message ? `: ${aktuell.message}` : "";
    teile.push(`${name}${code}${meldung}`);
    aktuell = aktuell.cause;
  }
  return teile.join(" <- ") || "unbekannter Fehler";
};

// Ein Schreibvorgang, dessen Ausgang unbekannt ist, ist gefaehrlicher als einer,
// der sicher nicht stattgefunden hat: im ersten Fall darf der Aufrufer weder
// "erledigt" noch "nichts passiert" annehmen. Nur wenn die Verbindung nie
// zustande kam, ist sicher, dass nichts geschrieben wurde.
const NIE_VERBUNDEN = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);
const wurdeNichtsGesendet = (error) => {
  let aktuell = error;
  for (let tiefe = 0; aktuell && tiefe < 5; tiefe += 1) {
    if (aktuell.code && NIE_VERBUNDEN.has(aktuell.code)) return true;
    aktuell = aktuell.cause;
  }
  return false;
};

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
      // Der nackte Statuscode liess offen, ob Rechte, Token oder Ziel schuld
      // waren. Der Antwortkoerper des Daemons sagt das meist — gekuerzt, damit
      // eine HTML-Fehlerseite den Kanal nicht flutet.
      const grund = body.trim().slice(0, 500);
      process.stdout.write(
        jsonRpcError(request.id, -32000, `HTTP ${response.status} vom Huly-MCP-Daemon${grund ? `: ${grund}` : ""}`) +
          "\n",
      );
      return;
    }

    const messages = response.headers.get("content-type")?.includes("text/event-stream")
      ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
      : [body.trim()];
    let wroteAnything = false;
    for (const message of messages) {
      if (message && message !== "[DONE]") {
        process.stdout.write(message + "\n");
        wroteAnything = true;
      }
    }
    if (!wroteAnything && request.id !== undefined && request.id !== null) {
      process.stdout.write(jsonRpcError(request.id, -32603, "Empty response from Huly MCP daemon") + "\n");
    }
  } catch (error) {
    const ausgang = wurdeNichtsGesendet(error)
      ? "Der Aufruf wurde NICHT ausgefuehrt."
      : "Ob der Aufruf ausgefuehrt wurde, ist unbekannt — Ergebnis zurueckelesen, bevor wiederholt wird.";
    process.stdout.write(
      jsonRpcError(request.id, -32603, `Huly MCP unavailable: ${describeError(error)}. ${ausgang}`) + "\n",
    );
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

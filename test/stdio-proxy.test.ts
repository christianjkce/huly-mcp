// OPS-55: Der stdio-Proxy war ungetestet, und genau dort ging die Diagnose
// verloren. Codex bekam beim Abschluss eines Vorgangs nur
// "Huly MCP unavailable: TypeError" — ohne Grund, ohne Hinweis, ob geschrieben
// wurde. Diese Tests halten fest, was eine Fehlermeldung leisten muss:
// den Grund nennen und sagen, ob der Aufruf stattgefunden hat.
//
// Bewusst als Blackbox ueber den echten Prozess: die Datei ist ein CJS-Shell
// ohne Exporte, und der Fehlerpfad haengt am echten `fetch` von Node.

import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const PROXY = new URL("../stdio-proxy.cjs", import.meta.url).pathname

const ANFRAGE = JSON.stringify({
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "invoke_tool", arguments: { toolName: "update_issue" } }
})

type RpcErrorResponse = { readonly id?: number; readonly error: { readonly code: number; readonly message: string } }

/** Schickt eine Anfrage durch den Proxy und gibt die erste Antwortzeile zurueck. */
const durchDenProxy = (endpoint: string): Promise<RpcErrorResponse> =>
  new Promise<RpcErrorResponse>((resolve, reject) => {
    const kind = spawn(process.execPath, [PROXY], {
      env: { ...process.env, HULY_MCP_HTTP_ENDPOINT: endpoint },
      stdio: ["pipe", "pipe", "pipe"]
    })
    let aus = ""
    kind.stdout.on("data", (d) => {
      aus += String(d)
    })
    kind.on("error", reject)
    kind.on("close", () => {
      const zeile = aus.split("\n").find((z) => z.trim())
      if (!zeile) return reject(new Error(`keine Antwort, stdout war leer`))
      resolve(JSON.parse(zeile) as RpcErrorResponse)
    })
    kind.stdin.write(`${ANFRAGE}\n`)
    kind.stdin.end()
  })

describe("stdio-proxy Fehlerdiagnose (OPS-55)", () => {
  describe("Daemon nicht erreichbar", () => {
    // Ein Port, auf dem sicher niemand lauscht: kurz binden, Nummer merken,
    // wieder freigeben. Feste Kleinstports taugen nicht — Node lehnt etwa
    // Port 9 schon als gesperrten Port ab ("bad port") und kommt gar nicht
    // erst bis zum Verbindungsversuch, den dieser Test pruefen will.
    let TOT = ""

    beforeAll(
      () =>
        new Promise<void>((fertig) => {
          const kurz = createServer()
          kurz.listen(0, "127.0.0.1", () => {
            const adresse = kurz.address()
            const port = typeof adresse === "object" && adresse ? adresse.port : 0
            kurz.close(() => {
              TOT = `http://127.0.0.1:${port}/mcp`
              fertig()
            })
          })
        })
    )

    it("nennt den Betriebssystemgrund statt nur den Fehlertyp", async () => {
      const antwort = await durchDenProxy(TOT)
      expect(antwort.error.message).toContain("ECONNREFUSED")
    })

    it("sagt, dass nichts geschrieben wurde", async () => {
      const antwort = await durchDenProxy(TOT)
      expect(antwort.error.message).toContain("NICHT ausgefuehrt")
    })

    it("faellt nicht mehr auf den nackten Klassennamen zurueck", async () => {
      // Der gemeldete Originalfehler in Wortlaut. Gegen die alte Fassung
      // schlaegt dieser Test fehl, gegen die neue haelt er.
      const antwort = await durchDenProxy(TOT)
      expect(antwort.error.message).not.toBe("Huly MCP unavailable: TypeError")
      expect(antwort.error.message).not.toMatch(/^Huly MCP unavailable: \w+$/)
    })

    it("behaelt die Anfragekennung, damit der Aufrufer zuordnen kann", async () => {
      const antwort = await durchDenProxy(TOT)
      expect(antwort.id).toBe(7)
      expect(antwort.error.code).toBe(-32603)
    })
  })

  describe("Daemon antwortet mit Fehlerstatus", () => {
    let server: Server
    let endpoint = ""

    beforeAll(
      () =>
        new Promise<void>((fertig) => {
          server = createServer((_anfrage, antwort) => {
            antwort.writeHead(403, { "content-type": "text/plain" })
            antwort.end("workspace membership missing for this account")
          })
          server.listen(0, "127.0.0.1", () => {
            const adresse = server.address()
            endpoint = `http://127.0.0.1:${typeof adresse === "object" && adresse ? adresse.port : 0}/mcp`
            fertig()
          })
        })
    )

    afterAll(() => new Promise<void>((fertig) => server.close(() => fertig())))

    it("reicht den Grund des Daemons durch statt nur den Statuscode", async () => {
      const antwort = await durchDenProxy(endpoint)
      expect(antwort.error.message).toContain("403")
      expect(antwort.error.message).toContain("workspace membership missing")
    })
  })
})

#!/usr/bin/env bash
set -euo pipefail

umask 077

# Node FEST verdrahten, nicht ueber den PATH suchen.
#
# Am 2026-08-13 lief der Zusteller aus dem Cron in eine Schleife aus Fehlermeldungen:
# Der Cron-PATH findet /usr/bin/node (v18), die interaktive Sitzung dagegen nvm-node
# (v24). Das Huly-Bundle braucht den `File`-Global, den Node 18 nicht kennt — Absturz
# mit "ReferenceError: File is not defined". Interaktiv liefen alle Pruefungen gruen,
# im Cron nichts. Ein Umgebungsunterschied, der sich nur im Betrieb zeigt.
NODE_BIN="${HULY_NODE_BIN:-/root/.nvm/versions/node/v24.14.0/bin/node}"
if [[ ! -x "$NODE_BIN" ]]; then
  # Lieber laut scheitern als still eine zu alte Fassung nehmen.
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || { echo "kein node gefunden" >&2; exit 1; }
fi
node_major="$("$NODE_BIN" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
if (( node_major < 20 )); then
  echo "node $node_major ist zu alt fuer den Huly-MCP (mindestens 20): $NODE_BIN" >&2
  exit 1
fi

key_file=/srv/projects/key.env

# Jedes CLI arbeitet unter eigener Identitaet, damit am Board steht, WER etwas getan
# hat. Vorher schrieben alle unter dem Owner-Konto — dann laesst sich am Autorfeld
# nicht unterscheiden, ob ein Kommentar vom Menschen oder von einem Agenten stammt.
#
# Das ist nicht nur Kosmetik: Der geplante Dispatcher (Aufgabe 65) darf auf eigene
# Kommentare nicht reagieren. Mit einem gemeinsamen Konto kann er das nicht erkennen
# und liefe in eine Rueckkopplung.
#
# Gesteuert ueber HULY_IDENTITY in der MCP-Konfiguration des jeweiligen CLI:
#   HULY_IDENTITY=codex  -> HulyTokenCodex
# Ohne die Variable gilt der alte gemeinsame HulyToken — bestehende Aufrufe brechen
# dadurch nicht.
identity="${HULY_IDENTITY:-}"
if [[ -n "$identity" ]]; then
  # erster Buchstabe gross: codex -> Codex
  schluessel="HulyToken${identity^}"
else
  schluessel="HulyToken"
fi

token=$(awk -F= -v k="$schluessel" '$1 == k { print substr($0, index($0, "=") + 1); exit }' "$key_file")
if [[ -z "$token" ]]; then
  echo "$schluessel fehlt in $key_file" >&2
  exit 1
fi

workspace=$(TOKEN="$token" "$NODE_BIN" --input-type=module -e '
const token = process.env.TOKEN
const parts = token.split(".")
if (parts.length !== 3) process.exit(1)
const payload = JSON.parse(Buffer.from(parts[1], "base64url"))
if (typeof payload.workspace !== "string" || payload.workspace.length === 0) process.exit(1)
process.stdout.write(payload.workspace)
')

exec env \
  HULY_URL=https://huly.jkce.de \
  HULY_TOKEN="$token" \
  HULY_WORKSPACE="$workspace" \
  HULY_TOOL_MODE=auto \
  PROXY_OUTPUT_STRICT=true \
  TOOLSETS="${HULY_TOOLSETS:-projects,issues,comments,documents,search,channels,cards}" \
  "$NODE_BIN" /srv/projects/huly-mcp/dist/index.cjs

#!/usr/bin/env bash
# Meldet, wenn npm eine neuere Fassung von @firfi/huly-mcp anbietet als die
# lokal installierte.
#
# Warum das noetig ist: Am 2026-08-20 hat sich AGY um 06:40 selbst von 1.1.11
# auf 1.1.16 aktualisiert und dabei den Kopfbetrieb gebrochen. Niemand hat es
# bemerkt, bis zwei Auftraege fehlschlugen. Der huly-MCP soll sich NICHT selbst
# aktualisieren -- aber wir wollen wissen, wenn es etwas Neues gibt.
#
# Meldet bewusst NUR eine Abweichung, nicht bei Gleichstand: ein taeglicher
# "alles unveraendert"-Alarm wird nach einer Woche ignoriert.
set -euo pipefail

PROJEKT="/srv/projects/huly-mcp"
MERKER="/var/lib/huly-mcp/gemeldete-version"
ALARM="/srv/projects/openclaw/send-telegram-alert.sh"

mkdir -p "$(dirname "$MERKER")"

lokal="$(python3 -c "import json;print(json.load(open('$PROJEKT/package.json'))['version'])" 2>/dev/null || true)"
if [ -z "$lokal" ]; then
  echo "$(date -Is) FEHLER: lokale Version nicht lesbar" >&2
  exit 1
fi

# Netzfehler duerfen NICHT als "keine neue Version" durchgehen.
if ! entfernt="$(timeout 60 npm view @firfi/huly-mcp version 2>/dev/null | tail -1 | tr -d '[:space:]')"; then
  echo "$(date -Is) FEHLER: npm nicht erreichbar -- Fassung UNBEKANNT, nicht 'aktuell'" >&2
  exit 1
fi
if [ -z "$entfernt" ]; then
  echo "$(date -Is) FEHLER: npm lieferte keine Version -- UNBEKANNT" >&2
  exit 1
fi

if [ "$lokal" = "$entfernt" ]; then
  echo "$(date -Is) OK: huly-mcp $lokal ist die neueste Fassung"
  exit 0
fi

# Entprellung: dieselbe neue Fassung nur einmal melden.
gemeldet="$(cat "$MERKER" 2>/dev/null || true)"
if [ "$gemeldet" = "$entfernt" ]; then
  echo "$(date -Is) OK: huly-mcp $entfernt bereits gemeldet (lokal $lokal)"
  exit 0
fi

meldung="huly-mcp: neue Fassung $entfernt verfuegbar (installiert: $lokal).
Nicht automatisch aktualisieren -- wir haben fuenf eigene Commits obendrauf
(Toolsets cards/chat). Siehe Vorgang zur MCP-Aktualisierung."

echo "$(date -Is) NEU: $meldung"
if [ -x "$ALARM" ]; then
  "$ALARM" "$meldung" || echo "$(date -Is) WARNUNG: Meldeweg fehlgeschlagen" >&2
fi
printf '%s\n' "$entfernt" > "$MERKER"

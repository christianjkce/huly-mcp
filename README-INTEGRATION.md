# Local Huly MCP Integration

This project contains the pinned Huly MCP source used by the local CLI
integrations.

## Runtime

- Source revision: `ffdb965`
- MCP version: `0.49.4`
- Huly URL: `https://huly.jkce.de`
- Authentication: token from `/srv/projects/key.env`, variable `HulyToken`
- Workspace: extracted from the token payload at process start; the value is
  never logged or stored in this repository
- Wrapper: `run-huly-mcp.sh`
- Toolsets: `projects,issues,comments,channels,search,activity,workspace`
- Mode: `auto`, with strict proxy filtering enabled

The wrapper reads only the Huly token from the root-owned `0600` key file.
No token, password, workspace ID, or generated runtime configuration belongs
in Git, Notion, or chat.

## Client registration

- Codex: global stdio MCP entry `huly`
- Claude Code: user-scope stdio MCP entry `huly`
- Antigravity/Gemini: `huly` entry in `/root/.gemini/config/mcp_config.json`

The wrapper is deliberately used instead of embedding credentials in any CLI
configuration. Restart a CLI session after changing the token or wrapper.

## Verification

- MCP initialize: passed with protocol `2025-06-18`
- `get_huly_context`: passed; token auth and self-hosted HTTPS origin detected
- `list_workspaces`: passed; workspace `ce1doc` returned
- `list_projects`: passed; project `TSK/Default` returned
- Claude created the disposable probe issue `TSK-2`; Codex added the handoff
  comment and closed it. Read-back confirmed the title, comment, and `Done`
  status.
- Antigravity loads the Huly server and reaches its MCP permission/schema
  layer, but the headless CLI currently emits no final response for the
  read-only probe. Its Huly read-back is therefore still open and must not be
  reported as passed.

During initialization Huly emits repeated model-sync warnings for missing
model documents. They do not prevent authentication or read access and are
recorded as an open observation. They must be reassessed before declaring the
three-CLI write workflow complete.

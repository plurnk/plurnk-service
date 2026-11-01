---
name: plurnk
description: Configure, customize, extend, and integrate Plurnk — settings (.env), models, operating policy (AGENTS.md), personas, skills, MCP servers, schedules, hooks, plugins, extensions, ACP clients, and systemd/nginx templates.
---

# Plurnk

| Need | Reference |
| --- | --- |
| Configuration cascade, persistence, permissions, skills, personas | [Configuration](references/configuration.md) |
| Daemon status, effective configuration, and validation | `plurnk-service config`, `plurnk-service config show`, `plurnk-service config check`, `GET /health` |
| Systemd user service unit and nginx reverse-proxy templates | [plurnk.service](plurnk.service), [plurnk.nginx.conf](plurnk.nginx.conf) |
| COPY/MOVE operands, source regions, destination placement | [Copy and move](references/copy-move.md) |
| Model routes, reasoning, output and context limits, cost | [Models](references/models.md) |
| Every installed package's settings and defaults | [Complete .env.defaults](.env.defaults) |
| Operating policy (`AGENTS.md` / `AGENTS.local.md`) and session instructions | `$XDG_CONFIG_HOME/plurnk/AGENTS.md`, `<project>/AGENTS.md` (`.local.md`), `session://<session>/AGENTS.md` |
| Personas (`persona://` and `plurnk_personas`) | [Personas](mcp:///plurnk_personas.md), `persona://<name>/PERSONA.md` |
| Agent Skills, MCP servers, environment variables, and schedules | `mcp:///plurnk_skills.md`, `mcp:///plurnk_mcp.md`, `mcp:///plurnk_env.md`, `mcp:///plurnk_schedule.md` |
| Which project files you can see, and why a file is missing | [Membership](mcp:///plurnk_members.md) |
| Plugins, extensions, clients and hooks: what each reaches and how it loads | [Extending Plurnk](references/extensibility.md) |
| Each installed package's contract and type declarations | `packages/<package name>/SPEC.md`, `dist/*.d.ts` |
| Session hierarchy, messaging, and delegation | [Session reference](plurnk:///session.md) |
| Running code: the shell and each interpreter's body, stdin, arguments, exit status | `plurnk:///sh.md`, `plurnk:///js.md`, `plurnk:///python3.md`, … |
| Enabled MCP server invocations and schemas | `mcp:///` |
| Built-in executors and scheme references | `plurnk:///` |

READ the relevant reference; FIND selects paths and searches their bodies or symbols across `skill://plurnk/**` (for example `FIND (skill://plurnk/packages/*/SPEC.md) ~ /§tag/` or `FIND (skill://plurnk/packages/**/dist/*.d.ts) & /Symbol/`), and `KILL (log:///...)` retires read slices once applied.
Defaults describe available settings; `plurnk-service config` and `plurnk-service config show` inspect the operator's effective configuration.

---
name: plurnk
description: Configure, customize, extend, and integrate Plurnk — settings (.env), models, operating policy (AGENTS.md), personas, skills, MCP servers, schedules, notifications, plugins, extensions, ACP clients, and systemd/nginx templates.
---

# Plurnk

| Need | Reference (relative to `skill://plurnk/` unless a URI or command) |
| --- | --- |
| Configuration cascade, persistence, permissions, skills, personas | [Configuration](configuration.md) |
| Daemon status, effective configuration, and validation | `plurnk-service config`, `plurnk-service config show`, `plurnk-service config check`, `GET /health` |
| Systemd user service unit and nginx reverse-proxy templates | [plurnk.service](configuration/plurnk.service), [plurnk.nginx.conf](configuration/plurnk.nginx.conf) |
| Copy/move operands, source regions, destination placement | [Copy and move](copy-move.md) |
| Line, column, and `@hash` anchor `range`s and replacement semantics | `mcp:///plurnk/edit.json`, [Copy and move](copy-move.md) |
| Model routes, reasoning, output and context limits, cost | [Models](models.md) |
| Every installed package's settings and defaults | [Complete .env.defaults](configuration/.env.defaults) |
| Operating policy (`AGENTS.md` / `AGENTS.local.md`) and session instructions | `$XDG_CONFIG_HOME/plurnk/AGENTS.md`, `<project>/AGENTS.md` (`.local.md`), `session://<session>/AGENTS.md` |
| Personas (`persona://` and `plurnk.personas`) | `mcp:///plurnk.md`, `mcp:///plurnk/personas.json`, `persona://<name>/PERSONA.md` |
| Agent Skills, MCP servers, environment variables, and schedules | `mcp:///plurnk.md`, `mcp:///plurnk/skills.json`, `mcp:///plurnk/mcp.json`, `mcp:///plurnk/env.json`, `mcp:///plurnk/schedule.json` |
| Which project files you can see, and why a file is missing | `mcp:///plurnk/members.json` |
| Plugins, extensions, clients and notifications: what each reaches and how it loads | [Extending Plurnk](extensibility.md) |
| Each installed package's contract and type declarations | `skill://plurnk/packages/<package name>/SPEC.md`, `skill://plurnk/packages/<package name>/dist/*.d.ts` |
| Session hierarchy, messaging, and delegation | [Session reference](session.md), [Delegation and messages](delegation.md) |
| Text, structural, full-text, and symbol patterns | [Patterns](pattern.md) |
| HTTP(S) web resources and WebSocket connections | [HTTP(S) resources](https.md), [WebSocket connections](wss.md) |
| Running code: the shell and each interpreter's body, script, arguments, exit status | `mcp:///plurnk.md`, `mcp:///plurnk/sh.json`, `mcp:///plurnk/js.json`, `mcp:///plurnk/python3.json` |
| Enabled MCP server invocations and schemas | `mcp:///` |

Read the relevant reference with `plurnk.read`; `plurnk.find` selects paths and searches their bodies or symbols across `skill://plurnk/**` (for example `await plurnk.find({ path: "skill://plurnk/packages/**/SPEC.md", pattern: "/§tag/" })` or `await plurnk.find({ path: "skill://plurnk/packages/**/dist/*.d.ts", pattern: "&Symbol" })`), and `await plurnk.kill({ path: "log:///...", note: "..." })` retires read slices once applied.
Defaults describe available settings; `plurnk-service config` and `plurnk-service config show` inspect the operator's effective configuration.

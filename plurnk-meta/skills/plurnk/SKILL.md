---
name: plurnk
description: Index of Plurnk operating environment and configuration references.
---

# Plurnk

Plurnk is a persistent operating environment shared by `model`, `client`, and `_plurnk` principals across `workspace:///`, `session://`, `env://`, `schedule://`, `persona://`, `skill://`, and `mcp://` (with or without a filesystem `project_root`): prefer native URI schemes, `pattern` selection, and `schedule` obligations over ad-hoc shell polling or scratch scripts.

| Need | Reference (relative to `skill://plurnk/` unless a URI or command) |
| --- | --- |
| Configuration cascade, persistence, permissions, skills, personas | [Configuration](configuration.md) |
| Daemon status, effective configuration, and validation | `plurnk-service config`, `plurnk-service config show`, `plurnk-service config check`, `GET /health` |
| Systemd user service unit and nginx reverse-proxy templates | [plurnk.service](configuration/plurnk.service), [plurnk.nginx.conf](configuration/plurnk.nginx.conf) |
| Copy/move operands, source regions, destination placement | [Copy and move](copy-move.md) |
| Line, column, and `@hash` anchor `range`s and replacement semantics | `mcp:///plurnk/edit.json`, [Copy and move](copy-move.md) |
| Model routes, reasoning, output and context limits, cost | [Models](configuration/models.md) |
| Every installed package's settings and defaults | [Complete .env.defaults](configuration/.env.defaults) |
| Operating policy (`AGENTS.md` / `AGENTS.local.md`) and session instructions | `$XDG_CONFIG_HOME/plurnk/AGENTS.md`, `<project>/AGENTS.md` (`.local.md`), `session://<session>/AGENTS.md` |
| Personas (`persona://` and `personas`) | `mcp:///plurnk.md`, `mcp:///plurnk/personas.json`, `persona://<name>/PERSONA.md` |
| Agent Skills, MCP servers, environment variables, and schedules | `mcp:///plurnk.md`, `mcp:///plurnk/skills.json`, `mcp:///plurnk/mcp.json`, `mcp:///plurnk/env.json`, `mcp:///plurnk/schedule.json` |
| Which project files you can see, and why a file is missing | `mcp:///plurnk/members.json` |
| Extensions, modules, ACP clients, bridges, and notifications | [Extending Plurnk](configuration/extensibility.md) |
| Each installed package's contract and type declarations | `skill://plurnk/packages/<package name>/SPEC.md`, `skill://plurnk/packages/<package name>/dist/**/*.d.ts` |
| Session hierarchy, messaging, and delegation | [Session and delegation](session.md) |
| Text, structural, full-text, and symbol patterns | [Patterns](pattern.md) |
| Web resources (`http`, `https`, `ws`, `wss`, and SSE) | [Web resources](https.md) |
| Running code: the shell and each interpreter's body, script, arguments, exit status | `mcp:///plurnk.md`, `mcp:///plurnk/sh.json`, `mcp:///plurnk/js.json`, `mcp:///plurnk/python3.json` |
| Enabled MCP server invocations and schemas | `mcp:///` |

Read the relevant reference with `read`; `find` selects paths and searches their bodies or symbols across `skill://plurnk/**` (for example `{"path": "skill://plurnk/packages/**/SPEC.md", "pattern": "/§tag/"}` or `{"path": "skill://plurnk/packages/**/dist/**/*.d.ts", "pattern": "&Symbol"}`), and `kill` (`{"path": "log:///...", "note": "..."}`) retires read slices once applied.
Defaults describe available settings; `plurnk-service config` and `plurnk-service config show` inspect the operator's effective configuration.

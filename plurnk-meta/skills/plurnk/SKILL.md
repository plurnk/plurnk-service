---
name: plurnk
description: Plurnk harness configurations, extensions, and definitions.
---

# Plurnk

| Need | Reference |
| --- | --- |
| Configuration cascade, persistence, permissions, skills | [Configuration](references/configuration.md) |
| COPY/MOVE operands, source regions, destination placement | [Copy and move](references/copy-move.md) |
| Model routes, reasoning, output and context limits, cost | [Models](references/models.md) |
| Every installed package's settings and defaults | [Complete .env.defaults](.env.defaults) |
| Plugins, extensions, clients and hooks: what each reaches and how it loads | [Extending Plurnk](references/extensibility.md) |
| Each installed package's contract and type declarations | `packages/<package name>/SPEC.md`, `dist/*.d.ts` |
| Session hierarchy, messaging, and delegation | [Session reference](plurnk:///session.md) |
| Which project files you can see, and why a file is missing | [Membership](mcp:///plurnk_members.md) |
| Agent Skills, MCP servers, environment variables, and schedules | `mcp:///plurnk_skills.md`, `mcp:///plurnk_mcp.md`, `mcp:///plurnk_env.md`, `mcp:///plurnk_schedule.md` |
| Running code: the shell and each interpreter's body, stdin, arguments, exit status | `plurnk:///sh.md`, `plurnk:///js.md`, `plurnk:///python3.md`, … |
| Enabled MCP server invocations and schemas | `mcp:///` |
| Built-in executors and scheme references | `plurnk:///` |

READ the relevant reference; FIND can select paths and search their bodies.
Defaults describe available settings, not the operator's effective configuration.

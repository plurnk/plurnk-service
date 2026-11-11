# Capability recipes

## Summary

Compose chat bridges, webhooks, scheduled jobs, browser and search tools, durable memory, skills, legacy agent config migration, and remote execution from built-in verbs, MCP discovery, and ACP clients.

## Synthesis order

1. **Built-in composition**: `session://` entries, `plurnk.schedule`, `https://` and `wss://`, `plurnk.find`, `plurnk.work` and `plurnk.fork`, and `plurnk.sh`, `plurnk.js`, and `plurnk.python3` execute directly in the workspace without extra processes.
2. **Discovery and binding**: `await plurnk.mcp({ discover: "<topic>" })` searches `PLURNK_MCP_REGISTRY_URL` (up to `PLURNK_MCP_REGISTRY_LIMIT` entries when non-empty) and returns launchable definitions for `plurnk.mcp`; `plurnk.skills`, `plurnk.personas`, and `plugin.json` bundles project local or shared definitions into the workspace.
3. **Out-of-process authoring**: a `SKILL.md` directory, a `stdio` or `streamable-http` MCP server, or an ACP v2 client bridge runs outside the daemon against the contracts in `skill://plurnk/packages/<package name>/SPEC.md` and `skill://plurnk/packages/<package name>/dist/*.d.ts`.

## Capability map

| Capability | Composition | Contract / surface |
| --- | --- | --- |
| Chat / IM bridge (Mattermost, Matrix, Slack, Discord, Telegram, Signal, Email) | External ACP v2 client at `/acp` (`PLURNK_PORT`) paired with a `GET /notifications` SSE consumer, authenticated via `PLURNK_AUTH_CLIENT_<id>='{"secret":"<secret>","scopes":["acp","notifications"]}'` (`PLURNK_AUTH=1`) with per-sender or per-channel `voice` principals | `skill://plurnk/packages/@plurnk/plurnk-acp/SPEC.md`, `skill://plurnk/packages/@plurnk/plurnk-auth/SPEC.md` |
| Inbound webhook or event trigger | HTTP receiver that exchanges `client_credentials` at `/oauth/token` and posts `session/prompt` to `/acp` or calls tools on `/mcp/<workspace>/<session>` | `skill://plurnk/packages/@plurnk/plurnk-acp/SPEC.md`, `skill://plurnk/packages/@plurnk/plurnk-mcp/SPEC.md` |
| Scheduled job, heartbeat, or digest | `plurnk.schedule` (`cron` 5-field expression or RFC 5545 `RRULE`) waking a session that emits `plurnk.send` (observed on `GET /notifications`) or calls an outbound MCP tool or `https://` endpoint | `mcp:///plurnk/schedule.json`, `skill://plurnk/packages/@plurnk/plurnk-schedule/SPEC.md` |
| Browser automation, web search, voice, or media | MCP servers (`playwright`, `chrome-devtools`, search, TTS/STT, image generation) discovered and bound through `plurnk.mcp` or declared in `mcp.json` | `mcp:///plurnk/mcp.json`, [Extending Plurnk](extensibility.md) |
| Durable and cross-session memory | Topic files in `session://<session>/*.md`, repository rules in `<project>/AGENTS.md` (`.local.md`), and user notes in `$XDG_CONFIG_HOME/plurnk/AGENTS.md`, queried with `plurnk.find` (`~` FTS5, `/` regex) | [Session reference](session.md), [Configuration](configuration.md), [Patterns](pattern.md) |
| Reusable workflow codification | `<project>/.agents/skills/<name>/SKILL.md` (project) or `$XDG_CONFIG_HOME/plurnk/skills/<name>/SKILL.md` (user) with `name` and `description` YAML frontmatter, inspected and enabled via `plurnk.skills` | `mcp:///plurnk/skills.json`, [Configuration](configuration.md) |
| Legacy agent config assimilation (`CLAUDE.md`, `.cursor*`, `.windsurf*`, `SOUL.md`) | `plurnk.find` locates legacy files, `plurnk.read` inspects them once, `plurnk.edit` records durable rules in `AGENTS.md`, `persona://<name>/PERSONA.md`, `.agents/skills/`, or `.agents/mcp.json`, and `plurnk.kill` on `log:///...` retires the read rows | [Configuration](configuration.md), `mcp:///plurnk/personas.json`, `mcp:///plurnk/kill.json` |
| Remote host or isolated sandbox execution | Remote Plurnk `/mcp/<workspace>/<session>` endpoint or SSH/container/sandbox MCP server bound via `plurnk.mcp` | `mcp:///plurnk/mcp.json`, `skill://plurnk/packages/@plurnk/plurnk-mcp/SPEC.md` |

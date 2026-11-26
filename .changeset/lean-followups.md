---
"@plurnk/plurnk-service": patch
"@plurnk/plurnk-agent-skills": patch
"@plurnk/plurnk-mimetypes": minor
"@plurnk/plurnk-mimetypes-application-ipynb": patch
"@plurnk/plurnk-mimetypes-application-json": patch
"@plurnk/plurnk-mimetypes-application-jsonl": patch
"@plurnk/plurnk-mimetypes-application-pdf": patch
"@plurnk/plurnk-mimetypes-audio": patch
"@plurnk/plurnk-mimetypes-image": patch
"@plurnk/plurnk-mimetypes-text-csv": patch
"@plurnk/plurnk-mimetypes-text-diff": patch
"@plurnk/plurnk-mimetypes-text-dotenv": patch
"@plurnk/plurnk-mimetypes-text-ini": patch
"@plurnk/plurnk-mimetypes-text-markdown": patch
"@plurnk/plurnk-mimetypes-text-plain": patch
---

Reduce cold-boot, CLI-command, and workspace-activation memory footprint
(#1582):

- Set `NODE_OPTIONS=--max-semi-space-size=4` and `MALLOC_ARENA_MAX=2` in
  `plurnk-core/plurnk.service` and document V8 semi-space/old-space/arena
  tuning in `plurnk-core/INSTALL.md`.
- Export `BaseHandler`, `HandlerContent`, and `projectJsonToXml` from
  `@plurnk/plurnk-mimetypes/runtime` and migrate built-in leaf mimetype
  handlers off the eager barrel onto `/runtime`, deferring structural query
  imports until invoked.
- Lazy-load `yaml` on first frontmatter parse in `@plurnk/plurnk-agent-skills`
  and `@plurnk/plurnk-mimetypes-text-markdown`.
- Dynamically import `Daemon`, `HttpListener`, `ServiceModules`, and
  `ProviderInstantiate` in `plurnk-core/src/service.ts` so CLI control commands
  avoid booting the full daemon and ACP graph.

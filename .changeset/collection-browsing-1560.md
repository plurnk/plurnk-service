---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-modules": major
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-skills": minor
"@plurnk/plurnk-acp": minor
---

Unify collection browsing, search, and pagination across Functionality families
(`{§client-collection-browsing}`, `#1560`):

- `@plurnk/plurnk-contracts`: Add `FunctionalityListQuery` (`query`, `state`,
  `origin`, `offset`, `limit`), bounded `offset`/`total`/`nextOffset` on
  `FunctionalityListResult`, `cursor`/`limit` on `FunctionalityDiscoverQuery`,
  `total`/`nextCursor` on `FunctionalityDiscoverResult`, structured `detail` on
  `FunctionalityCandidate`, and shared list/discover command parsing,
  pagination footers, and interactive completion flags.
- `@plurnk/plurnk-modules`: Add `FunctionalityDiscovery.required` and allow
  `FunctionalityAdapter.discover` to return a `FunctionalityDiscoverPage`.
- `@plurnk/plurnk-service`: Filter and paginate `list` across workspace and
  session families, paginate local discovery arrays via `offset:<N>` cursors,
  and emit structured preview `detail` from `members.discover`.
- `@plurnk/plurnk-mcp`: Support empty-query MCP Registry browsing
  (`emptyListsAll: true`) and upstream `nextCursor` pagination.
- `@plurnk/plurnk-skills`: Add optional `query` filtering alongside required
  `source` discovery.
- `@plurnk/plurnk-acp`: Type filtered/paginated `list` and `discover` actions
  and update `@agentclientprotocol/sdk` to `^2.12.0`.

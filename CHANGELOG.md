# Changelog

Notable user-visible changes will be recorded here.

This project is under active stabilization. Until a stable compatibility policy
is published, release notes may include breaking changes.

## Unreleased — the next publication after 1.16.5

Breaking for external AG-UI and RPC clients:

- The `worker://~/` alias is gone; a worker is addressed by its literal name.
- `worker.skills.*` actions are `workspace.skills.*`; Functionality is workspace-owned.
- `PLURNK_SERVICE_WORKER_WARM_*` knobs are `PLURNK_SERVICE_WORKSPACE_WARM_*`.
- `REASONING_ENCRYPTED_VALUE` is no longer emitted; the reasoning address form changed.
- `loop.inject` and `loop.cancel` never create a workspace: an unknown name is a 404
  `workspace-not-found`.
- The `BUFF` client operation left the language; a `BUFF` fence is an executor tag.
- `@plurnk/plurnk-execs` no longer exports the frozen `Advertise` helper.
- `@plurnk/plurnk-plurnkdown` is retired; the packet Markdown projection is specified in
  `plurnk-core/SPEC.md` (`§packet-markdown`).

Language and teaching:

- Executable fences, no lanes, one optional TASK disposition; unlabeled fences are literal SENDs.
- Matchers ride the heading as `[{"pattern": "…"}]` on FIND, READ, KILL, EDIT, COPY and MOVE;
  READ stays READ; node dialects replace whole regions on EDIT.
- A reply that opens with an operation heading is refused (`send-looks-like-operation`);
  delivered replies name the prompts they answered.
- An explicit empty `TASK` is a soft 409 receipt and never a strike; only a refused
  completion (pending work, unobserved failures, deferred receipts) strikes the review contract.
- `TASK` may sit anywhere in a turn: operations after it run in authored order and the
  disposition settles last; nothing is dropped and the `operations-after-disposition`
  diagnostic code is gone.
- A body beneath a FIND, READ or KILL heading is ignored with one `parse_advisory` notice
  naming the heading-line form; the operation still runs and nothing strikes.
- Naked patterns: the matcher rides the heading bare on FIND, READ and KILL (`FIND (src) TODO`,
  `READ (a.md) /bats?/i`, `KILL (log:///**) ~stale`); a sigil lifts on EDIT with the replacement
  beneath; `^…` is a regex without slashes; a trailing aside stays the aside. `[{"pattern": "…"}]`
  remains the escape and the COPY/MOVE operand form, and programs render matchers bare.
- A READ over a glob fans out: `READ (pets_*.md)` reads each matching path as an ordinary exact
  READ with its own receipt (the preview scope, or with a pattern only the matching lines), so
  every line keeps its path, ordinal and anchor; no path is one 204 on the glob. A READ is never
  rewritten into a FIND; the survey of paths is FIND.
- A scope position written `<@abcde 42>` reads as the anchor with one advisory, never a refusal.
- Recursive Reasoning: turn 0's reasoning READ is the pattern read
  `READ (reasoning:///L/T) ^NOTE:.* <!-- pluck notes from this turn's reasoning -->`, and the
  injected rationale carries one `NOTE:` line naming the next turn's coordinate, so the first
  packet shows the maneuver working.
- The language no longer counts backticks. A block closes at any fence of at least its
  opener's count (CommonMark), shorter inner fences are body, and a closer is never demanded:
  a block also ends at the next heading or at the end of the input. A numeric delimiter
  written after the backticks of both fences (the opener carrying `42EDIT (x)`, the closer
  carrying `42`) nests equal-count fences. A fence line of four or more backticks naming an
  operation or a known executor is a heading wherever it stands. Only operations and the
  workspace's executors open blocks; every other fence tag, and an unlabeled fence, is prose,
  so the implicit unlabeled-fence SEND is gone. A heading written outside any fence draws one
  advisory naming the fence form. `FIND (path) /regex/` lifts the bare matcher into
  `pattern`. `PlurnkParser.parse` takes `{ executors }`.
- Five tolerances from the first dumbox run on the anchored parser: an opener may follow a
  closer on the same line; `@` with one to four digits reads as that line number; an aside
  that never closes reads to the end of its line; an option a scheme does not take is dropped
  with a `metadata_ignored` notice; and a response with no operation is an admitted empty turn
  with a `turn_no_operations` notice and one strike, never a private resample.
- Indented fence lines are fence lines: leading whitespace on an opener or closer is ignored,
  bodies keep their own indentation.
- READ receipts name a resource's other channels with their tokens; a fetched page's source
  is its body and its curated Markdown is `#readable`; the Tavily materializer ships by default.
- A lean `plurnk.md`, one `## Delegation` section, and a lean turn 0.

Daemon and database:

- The packet's `## Worker` block follows the log and carries `{path, parent, loop, turn}`; the
  `## Turn` section and the date and time zone are gone. Nothing volatile precedes the log.

- The schema baseline is eight domain chapters; process triggers live beside the statements
  that fire them; the engine has no TX or EXEC blocks.
- Packet sections are rows over content-addressed items; whole-packet readers select from
  `turn_packets`. A database from an earlier release is recreated, not read.
- Retention is the operator's policy (`PLURNK_SERVICE_RETAIN_PACKET_*`,
  `PLURNK_SERVICE_COLLECT_*`, `PLURNK_SERVICE_RETENTION_INTERVAL_MS`); information is kept by
  default and transient data is collected.
- A worker's obligations are one view; cancellation is one bound statement; a fork is the
  claim of its branch row.

## Before 1.16.5 — notes recorded during stabilization

### Filesystem and skills

- Split user configuration and durable data across the XDG config and data
  homes. Existing pre-XDG installations move only through
  `plurnk-service paths migrate`, which refuses conflicts and verifies every
  copy before removing legacy sources.
- Discover Agent Skills from project `.agents/skills/`, user
  `~/.agents/skills/`, and the exact bundled fallback, with project-first
  precedence and no Plurnk-specific registration.
- Added `plurnk-service config`, `config edit`, `config defaults`, and
  `config check` as views over the existing environment cascade.
- Removed implicit `~/.plurnk` reads and the bespoke
  `@plurnk/plurnk-execs-skills` executor. Generated configuration references
  are now rendered on demand instead of copied into an operator home.

## 1.4.0 - 2026-08-06

### Changed

- Consolidated bundled packages into the platform monorepo.
- Added build provenance and a reproducible client-and-daemon candidate
  launcher.
- Simplified contributor guidance and architecture documentation.
- Replaced prose-to-test anchoring gates with behavioral `node:test` names.
- Standardized content regex matchers on ECMAScript `/pattern/flags` syntax.

### Removed

- Retired package hierarchy and aggregator release conventions.
- Removed obsolete architecture doctrine and duplicate planning documents.
- Removed regex target paths; targets now address exact paths or shell globs.

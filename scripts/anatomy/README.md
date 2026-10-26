# Anatomy tools

Deterministic helpers for reading and reshaping large classes. They were written for the 2.0 decomposition (#484) and stay here so the same procedure runs again instead of being reconstructed by hand. Every tool fails hard on a shape it does not understand; that is the signal to look, not to guess.

| Tool | Reads | Prints or writes |
| --- | --- | --- |
| `class-members.mjs <file.ts> [count]` | one source file | top-level declarations and class members with their line spans, largest first |
| `member-deps.mjs <file.ts> [minLines]` | one class file (4-space body) | for each member at least `minLines` long, the private fields and methods it touches — the map a split is planned from |
| `extract-class.mjs <spec.json>` | the origin file named in the spec | writes the new class file and rewrites the origin: the named members move, the fields and helpers they use are injected through the constructor, the origin constructs the class and delegates |
| `SPEC=spec.json carry-or-share.mjs <shared-module.ts> <doc> <const>...` | the spec's origin | decides, by usage, which of the named top-level consts only the spec's members use (added to the spec's `carryConsts`, transitively) and which the origin still needs (moved into the shared module, imported back) |
| `strip-unused-imports.mjs <file.ts>...` | the files | removes import specifiers no code outside the import block and comments uses |
| `spec-tag-inventory.mjs` | every `SPEC.md` and source file under the working directory | declared tags, where they are cited from, and the per-SPEC list of tags nothing cites |
| `harness-usage.mjs [--suites]` | `plurnk-core/test/intg` | which exports of the integration harness each suite uses, so a helper change is read against the suites it can redden (#887) |
| `clamp-audit.mjs <cmd>` | `plurnk-service`, `../plurnk`, `../plurnk-bench`, and `clamp-ledger.json` | drives and mechanically gates the 19-unit Specification & Coverage Review (`init`, `status`, `show`, `decide-tag`, `decide-test`, `verify`) |

## Specification and coverage clamp review (`clamp-audit.mjs`)

`scripts/anatomy/clamp-audit.mjs` and its checked-in ledger `scripts/anatomy/clamp-ledger.json` partition all 38 `SPEC.md` files (1,625 `§` tags) and all 972 `.test.*` files across `plurnk-service`, `../plurnk`, and `../plurnk-bench` into 19 bounded work units with hard numerical and structural budgets.

### Commands

1. `node scripts/anatomy/clamp-audit.mjs status [--unit <unit-id>]` — print the scoreboard across all 19 work units (live vs. budget ceilings for heading tags, non-heading tags, `SPEC.md` LOC, unit files, integration files, pending dispositions, and verification status).
2. `node scripts/anatomy/clamp-audit.mjs show <unit-id> [--pending]` — print the work unit's budgets, every `§` tag (declaration shape, line, code/test citation counts, disposition), every `.test.*` file (tier, LOC, `test()` count, untagged `test()` count, `openMigrated`/`launch` usage, disposition), and current verification blockers.
3. `node scripts/anatomy/clamp-audit.mjs decide-tag <unit-id> <tag> <disposition> [--target <heading-tag-or-doc>] --reason "<text>"` — record a tag disposition:
   - `keep-heading`: tag survives as a `## §tag` or `### §tag` heading in `SPEC.md`.
   - `fold-into` (`--target <heading-tag>`): prose is folded into the parent heading section; the micro-tag is removed from `SPEC.md` and `{§tag}` citations are re-pointed to `{§<heading-tag>}`.
   - `move-to-doc` (`--target <doc-path>`): architectural/process prose moved to `ARCHITECTURE.md` or `AGENTS.md`; tag removed from `SPEC.md` and code/tests.
   - `purge:<tombstone|pinned-wording|problem-table|internal-diary|duplicate|retired-shim>`: deleted from `SPEC.md`, `src/`, and `test/`.
4. `node scripts/anatomy/clamp-audit.mjs decide-test <unit-id> <file> <disposition> [--target <suite-path>] --reason "<text>"` — record a test file disposition:
   - `keep-suite`: approved canonical unit or integration suite.
   - `merge-into` (`--target <suite-path>`): unique assertions merged into the canonical domain suite and the fragmented file deleted via `git rm`.
   - `demote-to-unit` (`--target <unit-suite-path>`): in-memory/contract assertions moved out of `test/intg/` into `src/*.test.ts` and the `test/intg/` file deleted via `git rm`.
   - `purge:<tombstone|pinned-wording|duplicate|retired-shim|ceremony>`: deleted via `git rm`.
5. `node scripts/anatomy/clamp-audit.mjs verify [<unit-id> | --all]` — fail nonzero unless all 10 invariants hold for the unit:
   - Zero `"pending"` tags or test files remain, and every disposition has a specific `--reason` (≥ 15 chars, at most 3 identical reasons per unit).
   - 100% of surviving `§` tags in the unit's `SPEC.md` scope are declared on Markdown headings (`## §tag` or `### §tag`); zero paragraph, list, or table-row tag declarations remain.
   - Zero `<!-- map -->` tables remain in the unit's `SPEC.md` scope.
   - Zero `§pinned-wording-*` or `§problems-*` tags remain.
   - Every surviving heading `§` tag has both an implementation/panel citation (`src/` or `.env.defaults`) and a test citation (`*.test.*`).
   - Every tag marked `fold-into`, `move-to-doc`, or `purge:*` is absent from `SPEC.md` and absent from `{§tag}` citations across the repository.
   - Every test file marked `merge-into`, `demote-to-unit`, or `purge:*` has been removed from disk, and any `--target` suite exists.
   - Every `test(...)` block in surviving deterministic suites cites at least one `{§tag}`.
   - Live counts satisfy `minHeadingTags <= tags <= maxHeadingTags`, `specLines <= maxSpecLines`, `unitFiles <= maxUnitFiles`, and `intgFiles <= maxIntgFiles`.

## Extracting a class

1. `node scripts/anatomy/member-deps.mjs plurnk-core/src/core/Big.ts 60` — pick members whose field set is small and whose helpers are few.
2. Write the spec: `{ "file", "origin", "newClass", "newFile", "instanceField", "members": [...], "doc" }` (`instanceField` is the private field the origin will hold the new instance in, for example `"#kill"`; `doc` is the new file's first comment, without SPEC tags unless they resolve).
3. `node scripts/anatomy/extract-class.mjs spec.json`, then `node scripts/anatomy/strip-unused-imports.mjs <new file> <origin>`.
4. `npm run -s build -w <package>` and `npm run -s root:lint`; then the package's integration tier; then land through the gate.
5. To iterate, restore the origin (`git checkout -- <origin>`), delete the generated file, and rerun — the tool is idempotent from a clean origin.

What the tool injects on its own: the origin's fields the members read (by name, with their declared types), the origin's private, public, and static methods they call (as typed callbacks, bound by the origin), public static fields referenced as `Origin.name`, and initialized state fields — moved when only the extracted members use them, shared by reference when both sides do (the initializer must be `new X<...>()` so the type is known). Public members that move keep a two-line delegate in the origin, so external callers are untouched. Private statics referenced only from the moved set travel with it. A cut whose members are all static and need nothing injected becomes a class of statics with no instance in the origin; a static cut that would still need injected helpers is refused, because statics cannot reach instance fields — share those helpers in a module or include them in the cut. Members that reach inherited or public-field state (`this.name` with no declaration in the file, typically a class that `extends` a base) are refused: that is not a mechanical extraction.

Origin top-level `const`s that the moved members use are refused unless the spec lists them in `carryConsts`, which moves them into the new file (the tool checks the origin no longer needs them); a const both sides need goes to a shared module first (see `plurnk-core/src/core/statement-primary.ts`). A class name must not collide with a type the origin already imports.

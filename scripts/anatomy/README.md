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

## Extracting a class

1. `node scripts/anatomy/member-deps.mjs plurnk-core/src/core/Big.ts 60` — pick members whose field set is small and whose helpers are few.
2. Write the spec: `{ "file", "origin", "newClass", "newFile", "instanceField", "members": [...], "doc" }` (`instanceField` is the private field the origin will hold the new instance in, for example `"#kill"`; `doc` is the new file's first comment, without SPEC tags unless they resolve).
3. `node scripts/anatomy/extract-class.mjs spec.json`, then `node scripts/anatomy/strip-unused-imports.mjs <new file> <origin>`.
4. `npm run -s build -w <package>` and `npm run -s root:lint`; then the package's integration tier; then land through the gate.
5. To iterate, restore the origin (`git checkout -- <origin>`), delete the generated file, and rerun — the tool is idempotent from a clean origin.

What the tool injects on its own: the origin's fields the members read (by name, with their declared types), the origin's private, public, and static methods they call (as typed callbacks, bound by the origin), public static fields referenced as `Origin.name`, and initialized state fields — moved when only the extracted members use them, shared by reference when both sides do (the initializer must be `new X<...>()` so the type is known). Public members that move keep a two-line delegate in the origin, so external callers are untouched. Private statics referenced only from the moved set travel with it. A cut whose members are all static and need nothing injected becomes a class of statics with no instance in the origin; a static cut that would still need injected helpers is refused, because statics cannot reach instance fields — share those helpers in a module or include them in the cut. Members that reach inherited or public-field state (`this.name` with no declaration in the file, typically a class that `extends` a base) are refused: that is not a mechanical extraction.

Origin top-level `const`s that the moved members use are refused unless the spec lists them in `carryConsts`, which moves them into the new file (the tool checks the origin no longer needs them); a const both sides need goes to a shared module first (see `plurnk-core/src/core/statement-primary.ts`). A class name must not collide with a type the origin already imports.

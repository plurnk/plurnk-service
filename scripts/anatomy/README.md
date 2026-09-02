# Anatomy tools

Deterministic helpers for reading and reshaping large classes. They were written for the 2.0 decomposition (#484) and stay here so the same procedure runs again instead of being reconstructed by hand. Every tool fails hard on a shape it does not understand; that is the signal to look, not to guess.

| Tool | Reads | Prints or writes |
| --- | --- | --- |
| `class-members.mjs <file.ts> [count]` | one source file | top-level declarations and class members with their line spans, largest first |
| `member-deps.mjs <file.ts> [minLines]` | one class file (4-space body) | for each member at least `minLines` long, the private fields and methods it touches — the map a split is planned from |
| `extract-class.mjs <spec.json>` | the origin file named in the spec | writes the new class file and rewrites the origin: the named members move, the fields and helpers they use are injected through the constructor, the origin constructs the class and delegates |
| `strip-unused-imports.mjs <file.ts>...` | the files | removes import specifiers no code outside the import block and comments uses |
| `spec-tag-inventory.mjs` | every `SPEC.md` and source file under the working directory | declared tags, where they are cited from, and the per-SPEC list of tags nothing cites |

## Extracting a class

1. `node scripts/anatomy/member-deps.mjs plurnk-core/src/core/Big.ts 60` — pick members whose field set is small and whose helpers are few.
2. Write the spec: `{ "file", "origin", "newClass", "newFile", "instanceField", "members": [...], "doc" }` (`instanceField` is the private field the origin will hold the new instance in, for example `"#kill"`; `doc` is the new file's first comment, without SPEC tags unless they resolve).
3. `node scripts/anatomy/extract-class.mjs spec.json`, then `node scripts/anatomy/strip-unused-imports.mjs <new file> <origin>`.
4. `npm run -s build -w <package>` and `npm run -s root:lint`; then the package's integration tier; then land through the gate.
5. To iterate, restore the origin (`git checkout -- <origin>`), delete the generated file, and rerun — the tool is idempotent from a clean origin.

Origin top-level `const`s that the moved members use are refused: move them to a shared module first (see `plurnk-core/src/core/statement-primary.ts`). A class name must not collide with a type the origin already imports.

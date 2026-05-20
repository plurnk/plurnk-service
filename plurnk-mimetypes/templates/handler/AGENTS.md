# {{PACKAGE_NAME}} — Agent Collaboration Memory

Independent ownership boundary. This repo implements ONE thing: the `{{MIMETYPE}}` mimetype handler that plurnk-service consumes via plugin discovery.

If you find yourself reasoning about the duck contract shape, framework internals, sibling mimetypes, or engine behavior — stop. Those concerns live elsewhere; file an issue against the owning repo (see Cross-repo coordination below).

---

## Standing Rules (override anything else)

- **Scope discipline.** This repo implements one mimetype. Framework concerns live in `@plurnk/plurnk-mimetypes`. Engine concerns live in `plurnk-service`.
- **Duck-typed contract.** The handler is discovered at runtime by `@plurnk/plurnk-mimetypes` via `package.json` `plurnk.kind === "mimetype"`. The class extends `BaseHandler` (or `AntlrExtractor`); the framework derives `symbols`/`preview`/`validate` from `extract(content)`.
- **Plain TS as JS with hints.** No Zod, no Effect, no type-level metaprogramming. Per the plurnk family convention.
- **Conventional Commits.** No `Co-Authored-By: Claude` trailer.
- **AGENTS.md is gitignored.** Family convention — local working memory only.
- **File issues, not designed PRs**, when something upstream needs changing.

---

## Locked Decisions (foundation)

### Toolchain

- **Node ≥25**, ESM only.
- **TypeScript 6.0.3**, built to `dist/` via `tsconfig.build.json`.
- **Plain `tsc` build.** No bundler.
- **Test runner:** `node --test src/**/*.test.ts`.
- **Lint:** `tsc --noEmit` only.

### Source layout

- `src/{{CLASS_NAME}}.ts` — the handler class.
- `src/index.ts` — exports `default` + named.
- `src/{{CLASS_NAME}}.test.ts` — unit tests alongside source.
- `grammar/` — vendored `.g4` files (only for grammar-backed handlers).
- `src/generated/` — antlr-ng output (gitignored; built by `npx plurnk-mimetypes-compile`).

---

## Project State

v0.0.0. Scaffolded by `plurnk-mimetypes-init`. Implementation TODO.

---

## TODO

- [ ] Implement `extract(content)` returning `MimeSymbol[]` of structural declarations in `{{MIMETYPE}}` content.
- [ ] Add unit tests for the kinds of declarations specific to `{{MIMETYPE}}`.
- [ ] Update README with usage examples.
- [ ] For grammar-backed extraction: vendor `.g4` files in `grammar/`, run `npx plurnk-mimetypes-compile`, switch the parent class to `AntlrExtractor`, implement `parseTree()` and `createVisitor()`.

---

## Cross-repo coordination

| Concern | Where to file |
|---|---|
| Framework / duck contract changes | `@plurnk/plurnk-mimetypes` |
| Wire protocol / packet shape | `@plurnk/plurnk-grammar` |
| Engine internals / handler integration | `plurnk-service` |
| Tokenization / provider injection | `@plurnk/plurnk-providers-*` + `plurnk-service` |

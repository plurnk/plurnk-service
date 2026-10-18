# @plurnk/plurnk-parser

## 4.2.0

### Minor Changes

- dc0808c: Fence pairing: a heading the author enclosed in a wider or labeled fence is the
  example it was written as, at no cost to a complete reading; only a declared
  code block discarded as text still counts with a hidden operation. A message
  whose own fence is narrower than the fences wrapping its examples now holds them
  instead of running them ({§pairing-objective}, {§balanced-fences}; #1147).

### Patch Changes

- Updated dependencies [f320b9b]
- Updated dependencies [a619ed6]
- Updated dependencies [acffc4f]
- Updated dependencies [dc0808c]
  - @plurnk/plurnk-contracts@5.0.0

## 4.1.0

### Minor Changes

- 84c0d49: Replay each turn's complete admitted content operations together, in program
  order, as one assistant message immediately before that turn's receipts,
  retaining result bodies and resolved targets without duplicating authored
  requests. Curation removes replay with its owning receipt; immutable source and
  historical packets remain intact.
  
  Preserve READ/FIND body text as an ordinary NOTE before retrieval. Patterns belong
  on the header; below-header pattern and aside recovery are removed. Replace the
  NOTE legend with ordinary addressable NOTE receipts.

### Patch Changes

- Updated dependencies [84c0d49]
- Updated dependencies [1c19a58]
  - @plurnk/plurnk-contracts@4.1.0

## 4.0.0

- **Breaking:** remove LOOK and the client-only parser tier. Use
  `parseStatements` instead of `parseClient`; `ParseResult` and `ParseItem`
  are no longer generic. Client statements share the ordinary operation contract.
- Parse failures retain the attempted verb and exact statement for faithful
  protocol diagnostics, without changing the model's packet body or weight.
- Explicitly shaped executor invocations parse before their runtime is available;
  ordered dispatch resolves the current registry and permissions. Unknown slotless
  fences and quoted examples remain inert.
- Executor heading JSON is always input; metadata uses its bracketed slot.
  Remove the MIME-dependent `jsonBodyExecutors` parser option.
- Uses contracts 4.0.

## 3.0.3

### Patch Changes

- Third-party dependencies pulled forward to their latest stable versions: the
  AI SDK providers and `ai`, the MCP SDK, the OpenTelemetry packages, `express`,
  `music-metadata`, `smol-toml`, `web-tree-sitter`, `xpath`, `zod`, and the
  Models.dev catalog snapshot. `json-p3` stays at 2.3.1 while its newer archive
  requires a TypeScript compiler in production installs.
- Updated dependencies [960777f]
- Updated dependencies [f383d7d]
- Updated dependencies [0b7f8b1]
- Updated dependencies [42058d0]
- Updated dependencies [c8b3bb9]
  - @plurnk/plurnk-contracts@3.2.0

## 3.0.2

### Patch Changes

- 81f49f6: Report refused range syntax without inventing a replacement query. Resolve
  operator grammar filenames relative to the daemon's working directory.
- Updated dependencies [0060c82]
- Updated dependencies [6769a6a]
- Updated dependencies [1d585b4]
- Updated dependencies [eb33a1f]
  - @plurnk/plurnk-contracts@3.1.0

## 3.0.1

### Major Changes

- c053b24: Diagnostics say what happened, never why. An operation that takes no body names
  the lines it did not use instead of suggesting a pattern; a refused heading,
  scope or matcher carries the construct's working form instead of a rewrite of
  the input; advisories no longer name forms the parser did not apply.
- 85bcf56: Make parameterless KILL start the literal final-answer region. Everything after
  its heading belongs to the answer; an early closing fence can no longer discard
  the remainder or expose executable operations. Place operations before KILL.
  Targeted KILL and completion checks retain their existing behavior.

### Patch Changes

- Updated dependencies [8d9fb11]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
- Updated dependencies [69f3ffe]
- Updated dependencies [4153042]
- Updated dependencies [6c33cec]
- Updated dependencies [06960fc]
- Updated dependencies [f1bbc46]
- Updated dependencies [85bcf56]
- Updated dependencies [85bcf56]
  - @plurnk/plurnk-contracts@3.0.1

## 2.0.0

### Major Changes

- Establish the coordinated 2.0 baseline and independent package versioning. From
  this release onward, each package follows its own SemVer contract; compatible
  unchanged dependencies no longer force synchronized releases. Library and
  extension dependencies declare compatible ranges, while the service records its
  assembled dependency selection. Exact tested compositions accompany releases.

### Patch Changes

- Updated dependencies
  - @plurnk/plurnk-contracts@2.0.0

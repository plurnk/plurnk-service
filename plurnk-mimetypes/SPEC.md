# antlrmap Specification

## Purpose

antlrmap produces a **structural table of contents** for a codebase — a list of definitions and their locations. It answers the question: "what is defined here and where?"

It does **not** map usages, call graphs, dependencies, or relationships between symbols. That is a different tool.

---

## Guiding Principle

> List all symbols that are defined in a file and which are not confirmed to be invisible and/or inaccessible outside the file, with their parameters.

Imports, exports, and dependency edges are excluded — they describe *relationships*, not *definitions*. An LLM agent consuming a repomap needs to know what exists and where. When it needs to know what a file depends on, it reads the file.

---

## Symbol Mapping Policy

Every language mapping (`map.js`) must follow these rules. The goal is consistency across all 300+ languages so that consumers can rely on the shape of the output regardless of source language.

### Include (definitions visible outside the file)

| Kind | What it means | Examples |
|------|---------------|---------|
| `class` | A named class or struct declaration | `class Foo`, `struct Bar` |
| `function` | A named function declaration at module/file scope | `function parse()`, `def main()` |
| `method` | A function defined inside a class/struct/impl | `parse(source)`, `__init__(self)` |
| `field` | A named property/member declared on a class/struct | `#count`, `this.name`, `int x` |
| `interface` | An interface or protocol declaration | `interface Readable`, `protocol Codable` |
| `enum` | An enumeration type declaration | `enum Color`, `enum Direction` |
| `type` | A type alias or typedef | `type ID = string`, `typedef int score` |
| `module` | A module/namespace/package declaration | `module Foo`, `namespace Bar`, `package main` |
| `variable` | A named binding at module scope, **only if not confirmed private to the file** | `export const PORT = 3000` |
| `constant` | A named constant declaration visible outside the file | `pub const MAX: u32 = 100` |
| `heading` | A markdown heading line. Carries an extra `level` field (1-6). | `# Title`, `## Section` |

### Exclude (confirmed invisible or not definitions)

| Excluded | Reason |
|----------|--------|
| Imports | Dependency, not definition — visible by reading the file |
| Exports (as standalone symbols) | Relationship, not definition — the exported *declaration* is already captured |
| Local variables inside function/method bodies | Confirmed invisible — scoped to the function |
| Unexported module-scope variables (in languages with module privacy) | Confirmed invisible — e.g., non-exported `const` in ESM |
| Function/method calls and references | Usage, not definition |
| Control flow (if/for/while/switch) | Not a symbol |
| Comments and documentation | Not structural |
| String literals and magic numbers | Not a symbol |
| Anonymous functions/classes | No name to reference |

### Parameters

Functions and methods **must** include their parameter names when the grammar makes them available.

- `params` is an array of strings: `["source", "options"]`
- Destructured params use the raw text: `["{host, port}"]`
- Rest params include the ellipsis: `["...args"]`
- Default values are included in the text when part of the assignable: `["entryRule=\"program\""]`
- If a language grammar does not expose named parameters (e.g., some assembly grammars), omit the `params` field entirely.

### Scope Boundary

The mapping must identify the **scope boundary rule** in the grammar — the parser rule that separates "visible definitions" from "local implementation." In most languages this is the function/method body rule.

Examples:
- JavaScript: `functionBody` (the `{ ... }` block of a function/method)
- Python: indented suite after `def`/`class`
- Java: `methodBody`, `constructorBody`
- C: `compoundStatement` inside a function definition

Everything declared inside a scope boundary is excluded from the repomap.

The one exception: **class members** (methods, fields) are always included even though they are inside a class body, because they are the API surface of the class.

### Visibility Ambiguity

Some languages (C, Python, Lua) have no module-level privacy. In these cases, all file-scope declarations are potentially visible — include them. The rule is: **when in doubt, include**. Only exclude when the language's semantics *confirm* a symbol cannot be accessed from outside the file.

---

## Output Format

JSON array. One entry per file, each containing the file path and its symbols.

```json
[
  {
    "file": "lib/Parser.js",
    "symbols": [
      {
        "name": "Parser",
        "kind": "class",
        "line": 5,
        "endLine": 47
      },
      {
        "name": "parse",
        "kind": "method",
        "line": 18,
        "endLine": 26,
        "params": ["source"]
      }
    ]
  }
]
```

### Symbol fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | The symbol's identifier |
| `kind` | string | yes | One of the kinds listed in the Include table |
| `line` | number | yes | Start line (1-indexed) |
| `endLine` | number | yes | End line (1-indexed) |
| `params` | string[] | no | Parameter names, present on functions and methods when available |
| `level` | number | no | Heading depth 1-6, present on `heading` symbols |

### File entry fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | string | yes | Relative path from the target directory |
| `symbols` | object[] | yes | Array of symbols found in this file |

Files with zero symbols are omitted from the output.

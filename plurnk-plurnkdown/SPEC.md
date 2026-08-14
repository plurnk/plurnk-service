# Plurnkdown Specification

`@plurnk/plurnk-plurnkdown` owns the Markdown projection used for model packets and the
diagnostics produced by its linter. Core owns packet semantics and emits this format.

## §packet-markdown Ownership and wire boundary

| Layer                         | Owner                       | Contract                                                           |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------ |
| PLURNK operation language     | `@plurnk/plurnk-contracts`  | `plurnk.md`, parser, and language schemas {§contract-authority}    |
| Default sections and ordering | `@plurnk/plurnk-service`    | Ordered section list and trusted transform seam {§packet-assembly} |
| Section Markdown projection   | `@plurnk/plurnk-plurnkdown` | This specification                                                 |
| Section values and lifecycle  | Each producing package      | Producer-owned content under the core packet contract              |

Core renders the transformed section list into one system string and one user string. Within
each slot, list order is preserved. A nonempty section with a header renders as an H2, one blank
line, then its content. A null header renders only its content. Empty content is omitted, trailing
newlines are removed from each section, and rendered sections are separated by one blank line.

## §packet-default-projection Default packet projection

Core owns this order at {§packet-cache-monotone}. The diagram projects that contract into the two
Markdown strings; a trusted plugin may transform the section list before rendering
{§packet-plugin-transform}. Any node whose content is empty is absent from the wire.

```mermaid
flowchart LR
    subgraph system[system slot]
        direction LR
        definition["definition<br/>bare content"] --> policy["Policy"]
        policy --> project["Project Policy"]
        project --> tools["Registered Tools"]
        tools --> optional["Enabled Optional Operations"]
        optional --> schemes["Resources"]
        schemes --> notes["Operator Notes"]
    end

    subgraph user[user slot]
        direction LR
        log["Log"] --> streams["Child Streams"]
        streams --> workers["Active Child Workers"]
        workers --> errors["Errors"]
        errors --> notices["Notices"]
        notices --> git["Git Status"]
        git --> budget["Budget"]
        budget --> prompts["User Prompts"]
        prompts --> recap["Recap"]
    end
```

| Default section       | Slot   | Wire form                                     | Semantic owner                  |
| --------------------- | ------ | --------------------------------------------- | ------------------------------- |
| `definition`          | system | Bare `plurnk.md`; no wrapper heading          | {§definition-table-projection}  |
| `system-policy`       | system | Authored Markdown                             | {§policy-sections}              |
| `project-policy`      | system | Authored Markdown                             | {§policy-sections}              |
| `tools`               | system | Generated Markdown capability table          | {§tools-capability-sheet}       |
| `optional-operations` | system | `plurnk` fence                                | {§tools-capability-sheet}       |
| `schemes`             | system | `plurnk` fence                                | {§schemes-directory}            |
| `inject`              | system | Authored Markdown                             | {§packet-inject}                |
| `log`                 | user   | Dynamic `jsonplurnk` fence                    | {§jsonplurnk}                   |
| `child-streams`       | user   | `* <status> <path>` pointers                  | {§child-orientation}            |
| `child-workers`       | user   | `* <status> <path>` pointers                  | {§child-orientation}            |
| `errors`              | user   | `* <status> log:///<coordinate>` pointers     | {§operation-results}            |
| `notices`             | user   | Terse observation bullets                     | {§notice-drain-on-read}         |
| `git`                 | user   | One working-tree state line                   | {§packet-cache-monotone}        |
| `budget`              | user   | One ceiling, usage, percentage, and free line | {§tokenomics-neutral-telemetry} |
| `prompt`              | user   | `* prompt:///<loop>/<N>` pointers             | {§prompt-entry}                 |
| `requirements`        | user   | Authored operational recap                    | {§requirements}                 |

The authored `plurnk.md` keeps its human-aligned tables. Core removes table-cell padding only
from the `definition` packet projection under {§definition-table-projection}; fenced blocks and
non-table whitespace remain exact.

## §packet-invariants Projection invariants

Plurnkdown preserves the semantic evidence supplied by section owners.

| Invariant      | Required projection                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Addressability | Paths, URI fragments, log coordinates, scopes, and coordinate-prefixed body lines remain usable without translation.                          |
| Weighability   | The Budget line and log-row `tokens` / `itemsTokenTotal` values remain attached to the artifacts they measure.                                |
| Honesty        | Statuses, Problems, body visibility, chunk extents, and bodyless rows render as produced; presentation never upgrades or suppresses truth.   |
| Structure      | Typed operation examples and Log data remain typed fences rather than prose paraphrases.                                                      |

## §packet-operation-fences PLURNK operation fences

Model-facing operation examples use fenced blocks with the `plurnk` info string. A structural
PLURNK operation heading outside such a fence is an `op-fence` error. Each `plurnk` fence is parsed statement-by-statement by
`@plurnk/plurnk-contracts`; bounded diagnostics and {§unparsed-tail-boundary} surface as
`op-syntax` diagnostics under {§parse-diagnostics}.

Inline code may name a short operation form without becoming a block example. Other code-fence
languages are opaque to the PLURNK syntax check.

## §packet-jsonplurnk-exception Log fence

The Log is a fixed three-backtick `jsonplurnk` array owned by {§jsonplurnk}. It is valid GFM but
deliberately not labeled `json`: an open nonempty `body` uses one raw multiline quoted string rather than a JSON-escaped string.
Every physical body line begins with either a numeric `N:` or anchored
`@hash:N:` coordinate prefix. The closing quote appears at column zero before
either the object close or a following `chunk` member.
Coordinate prefixes keep source backticks out of the CommonMark closing-fence position, so content
cannot close the fixed fence. `@plurnk/plurnk-contracts` owns the deterministic transform that
recovers strict JSON.

## §packet-atomic-prose Atomic prose

Packet prose uses short, single-idea sentences. The linter emits a review warning for either of
these paragraph shapes:

- a sentence of at least 180 rendered characters;
- a sentence of at least 120 rendered characters containing a semicolon.

The rule measures rendered paragraph text rather than Markdown syntax. Headings, lists, tables,
and fenced blocks are structural content and are not measured. This is a heuristic, not a raw
document-size limit.

## §packet-lint Linter contract

| Rule        | Severity         | Trigger                                                                    |
| ----------- | ---------------- | -------------------------------------------------------------------------- |
| `op-fence`  | error            | A PLURNK operation heading occurs outside a `plurnk` fence.                |
| `op-syntax` | error or warning | A `plurnk` fence contains a parser diagnostic, advisory, or unparsed tail. |
| `run-on`    | warning          | Paragraph prose crosses an atomic-prose threshold.                         |

`PacketLint.lintDir` evaluates byte-exact digest files named
`packetNNN.system.md` and `packetNNN.user.md`. It ignores other digest artifacts, preserves the
originating filename on every finding, and does not claim semantic validation beyond these rules.

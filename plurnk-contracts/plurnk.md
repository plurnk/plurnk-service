# Plurnk Operation Protocol

> [!IMPORTANT]
> YOU MUST ONLY emit unwrapped Code Mode statements (`await plurnk.<op>(...);` and `await <server>.<tool>(...);`), with a terse `// aside` comment.

## Syntax

await plurnk.exampleOperation({ path: "...", range: "...", pattern: "...", metadata: [] }); // aside
await exampleServer.exampleTool({ key: "value" }); // aside

## Core Operations

* `plurnk.note({ text })`: Working memory. Save all new facts and ideas for later turns.
* `plurnk.todo({ text })`: List of remaining TODO items (absent if finished).
* `plurnk.find({ path?, range?, pattern?, metadata? })`: List matching paths, or the match locations inside one path.
* `plurnk.read({ path, range?, pattern?, metadata? })`: Read files, entries, streams, or only the lines a pattern selects.
* `plurnk.edit({ path, range?, pattern?, metadata?, content? })`: Create a file or entry; replace existing text by scope or by pattern.
* `plurnk.copy({ from, to })`: Copy files, entries, streams, or text regions (`{ path, range?, pattern?, metadata? }` or `"path"`).
* `plurnk.move({ from, to })`: Move files, entries, streams, or text regions (`{ path, range?, pattern?, metadata? }` or `"path"`).
* `plurnk.kill({ path, range?, pattern?, metadata?, note? })`: Delete an entry, stop a process, or retire log items.
* `plurnk.work({ target?, prompt, metadata? })`: Delegate to a child session (fresh log).
* `plurnk.fork({ target?, prompt, metadata? })`: Delegate to a child session (copied log).
* `plurnk.wait({ target?, seconds?, text? })`: Yield to child sessions or streams. You may include `seconds: 60` to check in after 60 seconds.
* `plurnk.send({ target?, range?, metadata?, text? })`: Deliver a new message.
* `plurnk.done({ target?, metadata?, text? })`: Deliver the final deliverable message, concluding an Open Message (oldest when target omitted).
* `plurnk.fail({ target?, metadata?, text? })`: Deliver the final failure message, concluding an Open Message (oldest when target omitted).

## Loop Protocol

> [!IMPORTANT]
> YOU MUST persist all new facts and ideas and emit a TODO list.

await plurnk.note({ text: "a finding or conclusion and its evidence" });

await plurnk.todo({ text: "- The first step.\n- The second step." });

await plurnk.send({ text: "a continuing progress update response" });

await plurnk.done({ text: "a final deliverable response" });

> [!TIP]
> The loop continues until all Open Work is resolved, with all Open Messages DONE or FAILed.

> [!TIP]
> YOU SHOULD NOT deliberate while discovering. Submit necessary NOTE, TODO, FIND and READ operations, then deliberate on the next turn.

## Delegation (plurnk:///delegation.md)

await plurnk.work({ target: "session://exampleSessionName", prompt: "Describe the child's complete task in the prompt." }); // the child's result lands in your log

## `pattern` (plurnk:///pattern.md)

| prefix | dialect                     | example                         |
|--------|-----------------------------|---------------------------------|
| `/`    | regex (ECMAScript)          | `/\btimeout\b/i`                |
| `//`   | xpath (1.0)                 | `//dependencies/*`              |
| `$`    | jsonpath (RFC 9535)         | `$.items[?(@.price>500)]`       |
| `~`    | full-text (SQLite FTS5)     | `~retry`                        |
| `&`    | graph (treesitter symbols)  | `&sym`, `&<sym`, `&>sym`        |
| none   | literal or glob/extglob     | `?(export )?(async )function *` |

> [!TIP]
> Patterns select source text as written, and `edit`'s `content` replaces all of it:
> `//book/@lang` selects `lang="en"`;
> `$.lang` selects `"en"` with its quotes.

## `range`

> [!TIP]
> Text scopes use 1-based lines and Unicode code-point columns across textual mimetypes.

| form            | endpoint rule                  |
|-----------------|--------------------------------|
| `"L"`, `"@hash"` | one line |
| `"SL,EL"`, `"@start,@end"` | lines SL through EL, inclusive |
| `"SL,SC,EL,EC"` | start included, end excluded — `"@abcde,5,@abcde,8"` is `bar` in line 42 `foo bar baz` |
| `"L,1,L,1"`, `"@hash,1,@hash,1"` | insert before that line |
| `"0"`, `"-1"`  | prepend / append on mutations; as an end line, `-1` is the last line |

## Workspace Navigation

await plurnk.find({ path: "src/**/*.ts", range: "1,-1", pattern: "/TODO/" }); // paths with matches; the range pages results, not lines

await plurnk.read({ path: "src/**/*.ts", range: "1,-1", pattern: "/TODO/" }); // the matching lines in every file

await plurnk.copy({ from: "sh:///ab3d5678", to: "build.log" }); // the command's output lands in a file, never in your context

* `path` may be a glob/extglob, permitting bulk operations.
* Log item paths nest: `log:///1/2/3/READ` is loop/turn/item/OP.
* FIND results hold one inner array per path: its channels, default first; append `#channel` to the path to select another: `"sh:///ab3d5678#stderr"`.
* Percent-encode in paths `(` as `%28` and `)` as `%29`.

## Membership (mcp:///plurnk/members.json)

await plurnk.members({ files: ["../exampleSisterProject/*.md", "../exampleSisterProject/example.json"] }); // adding membership tracking for files outside of the project folder

## Editing

await plurnk.edit({ path: "example.md", range: "@abcde", content: "bar" }); // READ showed 42<@abcde>foo bar baz; content replaces line 42

await plurnk.edit({ path: "example.md", range: "@abcde,@fghij", content: "bar" }); // content replaces lines 42 through 43

await plurnk.edit({ path: "example.md", range: "@abcde,5,@abcde,8", content: "qux" }); // READ showed 42<@abcde>foo bar baz; "bar" becomes content

await plurnk.edit({ path: "example.md", range: "@abcde,1,@abcde,1", content: "baz" }); // insert before line 42; line 42 stays

await plurnk.edit({ path: "example.md", range: "@fghij,1,@fghij,1", content: "qux" }); // insert after line 42: insert before line 43; insert after the last line: "-1"

await plurnk.edit({ path: "src/**/*.js", pattern: "/\\bfoo\\b/", content: "bar" }); // every match in every file becomes content

await plurnk.edit({ path: "books.xml", pattern: "//book[price > 35.00]", content: "" }); // an empty content removes each match

> [!TIP]
> YOU SHOULD address lines with batch-friendly `"@hash"` or `"@start,@end"` anchors to protect against stale targets.

## Context Curation

await plurnk.read({ path: "largeExampleFile.txt", range: "101,200" }); // READing in chunks if budget constrained

await plurnk.kill({ path: "log:///1/[1-7]/*/{READ,emission}", note: "example distillation or summarization" }); // old results, in bulk; note survives as a NOTE

## Environment (mcp:///plurnk/env.json)

await plurnk.env({ alias: "PLANET", value: "world" }); // persists for this session's commands

await plurnk.sh({ command: "echo \"Hello, $PLANET.\"" }); // greet the world

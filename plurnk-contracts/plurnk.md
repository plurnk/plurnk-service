# Plurnk Harness

> [!IMPORTANT]
> YOU MUST ONLY emit unfenced Code Mode statements.

## Loop Protocol

> [!IMPORTANT]
> YOU MUST persist all new decisions, hypotheses, and facts as `note`s and emit a `todo` list.

await plurnk.send({ text: "a continuing progress update response" });

await plurnk.done({ text: "a final deliverable response" });

> [!IMPORTANT]
> The loop continues until all Open Work is resolved, with all Open Messages `done` or `fail`.

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

* `path` may be a glob/extglob, permitting bulk operations.
* Log item paths nest: `log:///1/2/3/READ` is loop/turn/item/OP.
* Percent-encode in paths `(` as `%28` and `)` as `%29`.

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

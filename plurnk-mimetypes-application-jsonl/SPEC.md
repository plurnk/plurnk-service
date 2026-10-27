# JSONL handler

## §jsonl-records JSON Lines records and schema symbols

One JSON value per logical line. Blank lines and unparseable lines are skipped and never fatal, so a trailing newline or partial write does not poison the file.

| Surface | Contract |
|---|---|
| `validate` | Framework default no-op: no structural refusal. |
| `extractRaw` | Record schema (not rows): each distinct top-level key of an object record is one `field` symbol at the line it first appears, in first-appearance order. Array and scalar records contribute no symbols; count is bounded by schema width, never record count. |
| `deepJson` | Array of parsed records in file order. |
| `content` | Absent: the raw body is already readable JSON-per-line ({§mimetype-content}). |
| JSONPath / XPath | Locate `$[i]` as the record's value span on its line and nested values through the JSON owner's spans on that line ({§json-strictness}); `$` is the whole text ({§mimetype-query}). Regex and glob address physical lines. |

Raw source remains unchanged; binary input is decoded as UTF-8.

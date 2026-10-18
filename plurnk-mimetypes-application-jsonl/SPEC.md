# JSONL handler

§jsonl-records One JSON value per logical line. A blank line or a line that does
not parse is skipped, never fatal, so a trailing newline or a partial write does
not poison the file; `validate` is the framework no-op. `deepJson` is the array
of parsed records in file order. JSONPath and XPath locate `$[i]` as the record's
value span on its line and a nested value through the JSON owner's spans on that
line ({§json-value-spans}); `$` is the whole text ({§mimetype-query}).

§jsonl-schema Symbols are the record schema, not the rows: each distinct
top-level key of an object record is one `field` symbol at the line it first
appears, in first-appearance order. Array and scalar records contribute no
symbols. The symbol count is bounded by schema width, never by record count.

| Surface | Contract |
|---|---|
| `validate` | Framework default: no structural refusal ({§jsonl-records}). |
| `extractRaw` | The record schema ({§jsonl-schema}). |
| `deepJson` | The records array ({§jsonl-records}). |
| `content` | Absent: the raw body is already readable JSON-per-line ({§mimetype-content}). |
| JSONPath / XPath | Record and nested-value spans ({§jsonl-records}); regex and glob address the physical lines. |

Raw source remains unchanged. Binary input is decoded as UTF-8.

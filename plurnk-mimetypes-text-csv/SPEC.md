# CSV handler

## §csv-records CSV records, header symbols, and spans

One tokenizer yields field values and physical record offsets, preserving whitespace and quoted newlines, unescaping doubled quotes, accepting LF/CRLF/CR record separators, and retaining empty quoted fields at EOF.

| Surface | Contract |
|---|---|
| `validate` | Rejects unbalanced quotes and inconsistent column counts (not an exhaustive RFC 4180 validator). |
| `extractRaw` | Header names as `field` symbols spanning the header record, including multiline headers. |
| `deepJson` | Row objects keyed by header (duplicate names use the last column; missing fields project as `""`; extra fields are omitted; object-special names like `__proto__` remain data columns). |
| JSONPath / XPath | Both use the tokenizer's source offsets: a field carries its enclosing record's region, and multiline records never use row indexes as line numbers ({§mimetype-query}). |

Raw source remains unchanged. Structural projections accept strings; binary decoding belongs to the caller.

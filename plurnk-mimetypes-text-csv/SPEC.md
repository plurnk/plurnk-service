# CSV handler

§csv-records One tokenizer yields field values and physical record offsets.
It preserves whitespace and quoted newlines, unescapes doubled quotes, accepts
LF/CRLF/CR record separators, and retains empty quoted fields at EOF.

| Surface | Contract |
|---|---|
| `validate` | Reject unbalanced quotes and inconsistent column counts. Not an exhaustive RFC 4180 grammar validator. |
| `extractRaw` | Header names as `field` symbols spanning the header record, including multiline headers. |
| `deepJson` | Row objects keyed by header; duplicate names use the last column. Missing fields project as empty strings; extra fields are omitted. `validate` rejects those unequal-width records. |
| JSONPath / XPath | Both use the tokenizer's source offsets. A field has its enclosing record's region; multiline records never use row indexes as line numbers ({§mimetype-query}). |

Raw source remains unchanged. Object-special names such as `__proto__` are data
columns, not object mutations. Structural projections accept strings; binary
decoding belongs to the caller.

# Dotenv handler

## §dotenv-values Environment value projection and source framing

The `text/x-dotenv` handler uses `node:util.parseEnv` without modifying `process.env`, expanding variable references, or redacting values.

| Surface | Contract |
|---|---|
| `deepJson` | Flat key/string-value object; Node owns quoting, comments, multiline values, and duplicate-key resolution. |
| `extractRaw` | Recognized assignments as `constant` symbols spanning the complete assignment, including multiline values. |
| JSONPath / XPath | Query the value projection with enclosing source regions; a duplicate key points to its last assignment. Source framing locates assignments while Node parses each frame; a frame whose value disagrees with the complete parse supplies no query region ({§mimetype-query}). |

Raw source text remains unchanged.

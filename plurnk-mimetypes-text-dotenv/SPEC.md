# Dotenv handler

§dotenv-values The `text/x-dotenv` value projection uses `node:util.parseEnv`,
the same semantics as Node's environment-file loader. It neither modifies
`process.env` nor expands variable references or redacts values. Raw source
text remains unchanged.

| Surface | Projection |
|---|---|
| `deepJson` | Flat key/string-value object; Node owns quoting, comments, multiline values, and duplicate-key resolution. |
| `extractRaw` | Recognized assignments as `constant` symbols, spanning the complete assignment, including multiline values. |
| JSONPath / XPath | Query the value projection with enclosing source regions; a duplicate key points to its last assignment. |

§dotenv-source Source framing locates assignments; it does not interpret their
values. Node parses each frame. A frame whose value disagrees with the complete
parse supplies no query region. Source coordinates follow {§mimetype-query};
no line position is invented for an unlocated value.

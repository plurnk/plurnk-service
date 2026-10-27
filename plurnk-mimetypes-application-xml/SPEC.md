# XML handler

## §xml-shape XML shape, recovery, lexical spans, and logical text nodes

| Surface | Contract |
|---|---|
| `validate` | Framework default no-op; recovery is advisory ({§mimetype-channel-selection}). Only a defect outside xmldom's `ParseError` fails derivation. |
| `parseIssues` | Each recoverable xmldom `error` (such as an entity declared only in the internal DTD subset) counts as 1 issue and channels project the recovered DOM. Content that is not a document (xmldom `fatalError`: template or truncated file) counts as 1 issue, yields `[]` symbols and `null` `deepJson`, and refuses XPath/JSONPath with `QueryParseFailureError` (regex/glob unaffected). Empty input reports 0 issues and `[]` symbols. |
| `extractRaw` | Document shape: root element is a `module` symbol and each immediate child element is a `field` symbol named by `id`, else `name`, else tag name, with the root's tag name as `container` ({§mimetype-symbol}), each spanning its complete element. |
| `deepJson` | DOM as nested `{ type, attrs, children }` objects via `projectDomToJson` with source coordinates; text-only elements collapse to `text`, mixed content keeps `#text` siblings, and comments/processing instructions are omitted ({§mimetype-channel-architecture}). |
| JSONPath / XPath | XPath 1.0 runs over the real DOM and JSONPath over `deepJson`. Every node match selects its exact lexical source via the concrete syntax tree: elements without surrounding whitespace, attributes as `name = 'value'` as written, text with entity/character-reference/CDATA markup, and comments or processing instructions whole. XPath sees the XPath 1.0 logical text model (CDATA is text, adjacent text coalesces, empty text nodes do not exist, document node drops whitespace text and the XML declaration while keeping other processing instructions); `matched` is the logical string while the region is lexical source. Computed scalars are locator-only; malformed expressions throw `InvalidExpressionError` ({§mimetype-query}). |

Raw source remains unchanged; binary input is decoded as UTF-8.

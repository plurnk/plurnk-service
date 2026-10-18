# XML handler

§xml-shape Symbols are the document's shape, not its leaves: the root element is a
`module` symbol and each immediate child element is a `field` symbol named by its
`id` attribute, else its `name` attribute, else its tag name, with the root's tag
name as `container` ({§mimetype-symbol-container}). Every symbol spans its complete
element. Empty input or content that is not a document has no symbols.

§xml-recovery xmldom's recoverable `error` reports, such as an entity declared only
in the internal DTD subset, each count as one parse issue and the channels project
the recovered DOM. Content that is not a document (xmldom `fatalError`: a template,
a truncated file) counts as one issue, has no symbols and a `null` `deepJson`, and
refuses XPath and JSONPath with `QueryParseFailureError`; regex and glob run
unaffected ({§mimetype-parse-issues}). Empty input reports no issue. Only a defect
outside xmldom's own `ParseError` fails a derivation.

§xml-lexical-spans XPath runs over the real DOM (XPath 1.0 through `xpath`) and
JSONPath over the DOM projection; every node match selects its exact lexical source
through the concrete syntax tree: an element without surrounding whitespace, an
attribute as `name = 'value'` as written, text with its entity, character-reference
and CDATA markup, a comment or processing instruction whole. A computed scalar is
locator-only; a malformed expression is `InvalidExpressionError` ({§mimetype-query}).

§xml-text-nodes XPath sees the XPath 1.0 logical text model: a CDATA section is
text, adjacent text coalesces into one node, an empty text node does not exist,
and the document node carries neither whitespace text nor the XML declaration
while other processing instructions remain. `matched` is the logical string; the
region is the lexical source ({§xml-lexical-spans}).

| Surface | Contract |
|---|---|
| `validate` | Framework default; recovery is advisory ({§xml-recovery}). |
| `extractRaw` | Root and immediate children ({§xml-shape}). |
| `deepJson` | The DOM as nested `{ type, attrs, children }` objects through the framework's `projectDomToJson`, each with its source coordinates; a text-only element collapses to `text`, mixed content keeps `#text` siblings, comments and instructions are omitted ({§mimetype-channel-architecture}). |
| `parseIssues` | Recovery sites ({§xml-recovery}). |
| JSONPath / XPath | Lexical source spans ({§xml-lexical-spans}, {§xml-text-nodes}). |

Raw source remains unchanged. Binary input is decoded as UTF-8.

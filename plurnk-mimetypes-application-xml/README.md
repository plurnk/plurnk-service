# @plurnk/plurnk-mimetypes-application-xml

`application/xml` AND `text/xml` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. DOM-tree extraction via [@xmldom/xmldom](https://www.npmjs.com/package/@xmldom/xmldom); XPath 1.0 via [xpath](https://www.npmjs.com/package/xpath).

## install

```sh
npm i @plurnk/plurnk-mimetypes-application-xml
```

## what it does

Provides three channels per {§mimetype-channel-architecture}:

- **symbols** (`extractRaw` / `preview`) — root element as a `module`; immediate children as `field` symbols named by `id` attribute, `name` attribute, or tag name (in that order of preference). Surfaces enough shape for the model to recognize "this is RSS / this is SOAP / this is a Maven pom" without dumping every leaf.
- **deep-json** (`deepJson`) — full DOM tree as nested objects. Each element: `{ type: tagName, attrs: {...}, children: [...] }` per the framework's `attrs` convention. Text-only elements collapse to a `text` field; mixed content keeps text nodes as `{ type: "#text", text }` siblings.
- **deep-xml** (framework-projected) — the deep-json projected back to XML via `projectJsonToXml`. xpath queries like `//book[@id='b1']/title` work naturally.

`query()` overrides the `xpath` dialect to run against the real DOM (via the `xpath` package's XPath 1.0 engine over xmldom). `jsonpath` inherits the framework's default dispatch against `deepJson`. `regex` and `glob` inherit text-based scanning.

## license

MIT.

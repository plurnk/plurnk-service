# @plurnk/plurnk-mimetypes-application-xml

`application/xml` and `text/xml` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. DOM via [@xmldom/xmldom](https://www.npmjs.com/package/@xmldom/xmldom), XPath 1.0 via [xpath](https://www.npmjs.com/package/xpath), source extents via [@lezer/xml](https://www.npmjs.com/package/@lezer/xml).

## install

```sh
npm i @plurnk/plurnk-mimetypes-application-xml
```

## what it does

- `extractRaw(content)` emits the root element and its immediate children: enough shape to recognize RSS, SOAP or a Maven pom without every leaf ({§xml-shape}).
- `deepJson(content)` is the DOM as nested objects ({§mimetype-channel-architecture}); `xpath` runs against the real DOM and every match selects its exact lexical source ({§xml-shape}).
- A recoverable xmldom report is counted, not fatal; content that is not a document projects nothing and stays text-searchable ({§xml-shape}).

## license

MIT.

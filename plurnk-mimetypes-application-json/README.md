# @plurnk/plurnk-mimetypes-application-json

`application/json` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```
npm install @plurnk/plurnk-mimetypes-application-json
```

plurnk-service discovers this handler automatically via its `plurnk.kind: "mimetype"` declaration.

## what it does

- `validate(content)` throws on malformed JSON (via `JSON.parse`). Per framework error policy, this error propagates to the caller as a contract violation.
- `extract(content)` returns the document's top-level keys as `field` symbols. Nested keys are out of scope; a JSON document's "API surface" is its top level. Line numbers come from a single-pass scan of the raw source.
- Array and scalar JSON roots have no named top-level keys → empty `Symbol[]`.

## development

```
npm install
npm run build
npm test
```

## license

MIT.

# @plurnk/plurnk-mimetypes-application-json

`application/json` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```
npm install @plurnk/plurnk-mimetypes-application-json
```

plurnk-service discovers this handler automatically via its `plurnk.kind: "mimetype"` declaration.

## what it does

- `validate(content)` throws on malformed JSON via jsonc-parser — strict for `application/json`, permissive (comments + trailing commas) for `application/jsonc`. Per framework error policy, this error propagates to the caller as a contract violation.
- `extractRaw(content)` returns every key occurrence at every depth as a `field` symbol, with line numbers from jsonc-parser's positional tree.
- Array and scalar JSON roots have no named keys → empty `MimeSymbol[]`.

## development

```
npm install
npm run build
npm test
```

## license

MIT.

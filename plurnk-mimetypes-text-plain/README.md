# @plurnk/plurnk-mimetypes-text-plain

`text/plain` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm install @plurnk/plurnk-mimetypes-text-plain
```

plurnk-service discovers this handler automatically via its `plurnk.kind: "mimetype"` declaration in `package.json`.

## what it does

Nothing structural. text/plain has no symbols to extract — [`BaseHandler`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes)'s defaults (empty `extractRaw`, no-op `validate`, derived `symbolsRaw`/`preview`) are exactly right. When the framework's `Mimetypes.process` calls this handler and gets back no symbols, its raw-content fallback path supplies the preview.

## development

```sh
npm install
npm run build
npm test
```

## license

MIT.

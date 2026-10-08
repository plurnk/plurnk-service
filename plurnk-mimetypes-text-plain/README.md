# @plurnk/plurnk-mimetypes-text-plain

`text/plain` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm install @plurnk/plurnk-mimetypes-text-plain
```

plurnk-service discovers this handler automatically via its `plurnk.kind: "mimetype"` declaration in `package.json`.

## what it does

Nothing structural. text/plain has no symbols to extract — [`BaseHandler`](https://github.com/plurnk/plurnk-service/tree/main/plurnk-mimetypes)'s defaults (empty `extractRaw`, no-op `validate`, derived `symbolsRaw`) are exactly right.

## development

```sh
npm install
npm run build
npm test
```

## license

MIT.

# @plurnk/plurnk-mimetypes-text-plain

`text/plain` and `text/stream` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm install @plurnk/plurnk-mimetypes-text-plain
```

## what it does

Nothing structural: plain text has no symbols to extract, so the handler is `BaseHandler`'s defaults under two registered names ({§plain-text-defaults}). Regex and glob match the raw body, which is readable as it is.

## license

MIT.

# @plurnk/plurnk-mimetypes-image

`image/png`, `image/jpeg`, `image/gif` and `image/webp` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Binary content; nothing is decoded.

## install

```sh
npm i @plurnk/plurnk-mimetypes-image
```

## what it does

The package declares `plurnk.binary: true`, so the framework hands the handler a `Uint8Array` ({§mimetype-handler-content}). The handler reads only the format's header ({§mimetype-image}): `validate` refuses a mislabelled file by its magic, and `content`, `summary`, `facts` and `deepJson` are the header's facts — format, pixel dimensions when the header carries them, byte size. The picture itself is the service's to attach to a packet ({§packet-attachment-parts} in the core specification).

## license

MIT.

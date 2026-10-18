# @plurnk/plurnk-mimetypes-audio

Binary audio handlers for the [plurnk](https://github.com/plurnk) ecosystem: WAV, MPEG, FLAC, Ogg, MP4, AAC, WebM and AIFF, as `package.json` declares them. Bundled with the service and loaded on demand.

## install

```sh
npm i @plurnk/plurnk-mimetypes-audio
```

## what it does

Ordinary `READ` exposes format, duration (when known) and byte size ({§mimetype-audio-facts}); the service delivers the retained source bytes to models whose catalog declares audio input ({§packet-attachment-parts}). No transcription, sample decoding or transcoding. `.webm` is not inferred to be audio; an explicit `audio/webm` source type is.

## license

MIT.

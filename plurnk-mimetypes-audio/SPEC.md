# Audio handler

## §mimetype-audio Container header inspection, duration facts, and binary projection

`Audio` (`plurnk.binary: true`) handles binary audio containers and streams (`audio/wav`, `audio/x-wav`, `audio/vnd.wave`, `audio/mpeg`, `audio/flac`, `audio/ogg`, `audio/mp4`, `audio/aac`, `audio/webm`, `audio/aiff`) without decoding audio samples ({§mimetype-binary-input}). Raw bytes ride the packet as a native audio attachment on audio-capable routes ({§log-wire-format}):

| Surface | Contract |
| --- | --- |
| Lazy parser & memoization | Imports `music-metadata` lazily on first inspection (`skipCovers: true`, `skipPostHeaders: true`, `duration: true`) and shares one `Promise<AudioFacts>` per `Uint8Array` instance via a `WeakMap`. |
| `validate` | Requires `Uint8Array` (`TypeError` on text) and a recognized container with positive `numberOfChannels` (`SyntaxError` when no audio track is identified, {§mimetype-binary-input}). |
| `facts`, `deepJson` | `{ format, duration, bytes }`, where `format` is the detected container label, `duration` is finite non-negative seconds (`null` when unmeasured), and `bytes` is `byteLength`. |
| `content`, `summary` | One facts line: `<format> audio[, <duration> s], <bytes> bytes`. |

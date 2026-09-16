# @plurnk/plurnk-mimetypes-audio

Binary audio handlers for PLURNK. Bundled with the service and loaded on demand.

Ordinary `READ` exposes format, duration (when known), and byte size. The service
delivers the same retained source bytes to models whose catalog declares audio
input. Byte-scoped reads still return their selected hexadecimal lines.

[music-metadata](https://github.com/borewit/music-metadata) parses the container;
this package does not transcribe, decode samples, or transcode. Actual accepted
codecs depend on the model/provider. `.webm` is not inferred to be audio; an
explicit `audio/webm` source type is supported.

See {§mimetype-audio-facts} in the [mimetype specification](../plurnk-mimetypes/SPEC.md)
and {§packet-attachment-parts} in the [core specification](../plurnk-core/SPEC.md).

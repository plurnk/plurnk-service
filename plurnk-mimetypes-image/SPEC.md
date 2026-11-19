# Image handler

## §mimetype-image Raster header validation, dimensions, EXIF facts, and binary projection

`Image` (`plurnk.binary: true`) handles raster formats (`image/png`, `image/jpeg`, `image/gif`, `image/webp`); vector `image/svg+xml` remains XML text under `+xml` classification ({§mimetype-binary-input}). No pixel data is decoded; read-only text projection derives from header magic, dimensions, and EXIF tags while raw bytes ride the packet as a native image attachment on vision-capable routes ({§log-wire-format}):

| Format | MIME type & extensions | Header magic (`validate`) | Dimensions (`facts`) |
| --- | --- | --- | --- |
| PNG | `image/png` (`.png`) | `\x89PNG\r\n\x1a\n` | Big-endian 32-bit `width`, `height` in `IHDR` (`bytes >= 24`), else `null` |
| JPEG | `image/jpeg` (`.jpg`, `.jpeg`) | `\xff\xd8\xff` | First `SOF0`–`SOF15` marker (excluding `DHT`, `JPG`, `DAC`) before `SOS`/`EOI`, else `null` |
| GIF | `image/gif` (`.gif`) | `GIF87a` or `GIF89a` | Little-endian 16-bit `width`, `height` at bytes `6..10`, else `null` |
| WebP | `image/webp` (`.webp`) | `RIFF....WEBP` | `"VP8 "`, `VP8L`, or `VP8X` canvas dimensions (`bytes >= 30`), else `null` |

| Surface | Contract |
| --- | --- |
| `validate` | Requires `Uint8Array` (`TypeError` on text) and matching header magic (`SyntaxError` on mismatch, {§mimetype-binary-input}). |
| `facts`, `deepJson` | `{ format, width, height, bytes, exif? }`, extracting non-empty printable EXIF descriptions (omitting pointer/`MakerNote`/`ApplicationNotes` and `[Raw …]`/`[unable to …]` placeholders) plus finite `GPSLatitude`, `GPSLongitude`, and `GPSAltitude`. |
| `summary` | `<Label> image[, <W>×<H> px], <N> bytes[ — <ImageDescription>]`. |
| `content` | `summary` followed by `<Tag>: <value>` lines for remaining `exif` entries, queryable via inherited text matchers. |

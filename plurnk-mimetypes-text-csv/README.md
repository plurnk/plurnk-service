# @plurnk/plurnk-mimetypes-text-csv

`text/csv` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm i @plurnk/plurnk-mimetypes-text-csv
```

## what it does

- `validate(content)` walks all records with the bundled RFC 4180 tokenizer; throws on unbalanced quotes or non-uniform column count.
- `extractRaw(content)` emits one `field` symbol per header column, spanning the first record.
- `deepJson(content)` projects rows keyed by header. JSONPath and XPath retain real source regions, including records containing quoted newlines ({§csv-records}).

CSV's structural signal is the header row's column names — that's what surfaces in `symbols`. The actual data body is best previewed via the framework's raw-content fallback.

## why no parser dependency

The shared tokenizer (`parseAll`) is exported for reuse. It accepts LF and CR
record separators as well as RFC 4180's CRLF; validation checks balanced quotes
and uniform columns, not the entire RFC grammar.

Tests carry the complete [csv-spectrum 2.0.0 corpus](https://github.com/max-mapper/csv-spectrum/tree/d30e80f8b99d2eecb3778f1d7b9ed1cb425502ec).
All 11 consistent pairs agree. The remaining `location_coordinates` pair has
unquoted embedded quotes outside RFC 4180 and mismatched expected data; it is
identified explicitly, not counted as parser conformance. Fixture provenance
and licensing are in `test/fixtures/README.md`.

## license

MIT.

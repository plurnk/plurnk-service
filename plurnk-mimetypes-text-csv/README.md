# @plurnk/plurnk-mimetypes-text-csv

`text/csv` mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```
npm i @plurnk/plurnk-mimetypes-text-csv
```

## what it does

- `validate(content)` walks all records with the bundled RFC 4180 tokenizer; throws on unbalanced quotes or non-uniform column count.
- `extract(content)` emits one `field` symbol per header column (the first record), at line 1.

CSV's structural signal is the header row's column names — that's what surfaces in `symbols`. The actual data body is best previewed via the framework's raw-content fallback.

## why no parser dependency

CSV is the textbook case where RFC 4180 fits in <100 LOC of careful hand-rolled tokenizer and the available libraries all carry transitive dependencies that don't earn their keep for header extraction. The tokenizer (`parseAll`) is exported for re-use.

## license

MIT.

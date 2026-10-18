# @plurnk/plurnk-mimetypes-application-ipynb

`application/x-ipynb+json` (Jupyter notebook) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem.

## install

```sh
npm i @plurnk/plurnk-mimetypes-application-ipynb
```

## what it does

A notebook file is JSON, but a reader wants the narrative and the code, so the load-bearing channel is `content`:

- `content(content)` projects the notebook to reading Markdown: markdown cells verbatim, code cells fenced in the kernel language, text outputs folded in, images dropped ({§ipynb-reading}).
- `extractRaw(content)` indexes that projection: headings become `heading` symbols and code cells `module` symbols ({§ipynb-cells}).
- `deepJson(content)` is the parsed notebook; JSONPath and XPath carry regions in the notebook JSON, and `validate` is the JSON gate ({§ipynb-source}).

## fixtures

Positive notebook fixtures are checked against Jupyter's [nbformat v4.5 schema, pinned to nbformat v5.10.4](https://github.com/jupyter/nbformat/blob/v5.10.4/nbformat/v4/nbformat.v4.5.schema.json).
The schema and its BSD-3-Clause license live under `test/`; neither ships in the runtime package.

## license

MIT.

# @plurnk/plurnk-mimetypes-application-ipynb

`application/x-ipynb+json` (Jupyter notebook) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Uses `jsonc-parser` for source coordinates.

## install

```sh
npm i @plurnk/plurnk-mimetypes-application-ipynb
```

## what it does

A `.ipynb` *is* JSON, but the JSON is the noise — a model reading a notebook wants the narrative and code as a reader sees them, not `{"cell_type":"code","source":[...]}`. So the load-bearing channel here is the **content channel** (SPEC §18):

- `content(content)` — the notebook projected to clean **reading markdown**: markdown cells verbatim, code cells fenced in the kernel language, text/stream/`text/plain`/error-traceback outputs folded in, images and other binary payloads dropped.
- `extractRaw(content)` — symbols that index into that same projection: markdown headings become `heading` symbols (outline-nesting by level, like text-markdown), each code cell becomes a `module` symbol spanning its fenced block (named `In[n]` by execution count). An outline of a notebook reads as its sections with their code cells nested underneath.
- `deepJson(content)` — the parsed notebook verbatim, so jsonpath/xpath reach `$.cells[*].cell_type`, `$.metadata.kernelspec.language`, etc.
- `query(content, dialect, pattern)` — JSONPath and XPath carry source regions from the notebook JSON, not the separate readable Markdown projection ({§mimetype-content-query}).
- `validate(content)` — strict JSON source gate, invoked before orchestrated projections and structural queries.

References are deferred: a notebook's imports/calls are kernel-language code, and classifying them would mean embedding a per-kernel parser — out of scope for v1.

## license

MIT.

All positive notebook fixtures are checked against Jupyter's [nbformat v4.5 schema, pinned to nbformat v5.10.4](https://github.com/jupyter/nbformat/blob/v5.10.4/nbformat/v4/nbformat.v4.5.schema.json).
The schema and its BSD-3-Clause license live under `test/`; neither ships in the
runtime package. A negative cell-ID case verifies the checker. This is fixture
validation, not a new strict-schema requirement on the runtime's tolerant reader.

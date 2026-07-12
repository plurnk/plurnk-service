# @plurnk/plurnk-mimetypes-application-ipynb

`application/x-ipynb+json` (Jupyter notebook) mimetype handler for the [plurnk](https://github.com/plurnk) ecosystem. Hand-rolled, no parser dependency.

## install

```
npm i @plurnk/plurnk-mimetypes-application-ipynb
```

## what it does

A `.ipynb` *is* JSON, but the JSON is the noise — a model reading a notebook wants the narrative and code as a reader sees them, not `{"cell_type":"code","source":[...]}`. So the load-bearing channel here is the **content channel** (SPEC §18):

- `content(content)` — the notebook projected to clean **reading markdown**: markdown cells verbatim, code cells fenced in the kernel language, text/stream/`text/plain`/error-traceback outputs folded in, images and other binary payloads dropped. This is also the **embed-source**, so a notebook's embedding reflects what it *says*, not its JSON envelope.
- `extractRaw(content)` — symbols that index into that same projection: markdown headings become `heading` symbols (outline-nesting by level, like text-markdown), each code cell becomes a `module` symbol spanning its fenced block (named `In[n]` by execution count). An outline of a notebook reads as its sections with their code cells nested underneath.
- `deepJson(content)` — the parsed notebook verbatim, so jsonpath/xpath reach `$.cells[*].cell_type`, `$.metadata.kernelspec.language`, etc.
- `extent` — the projection's line count. `validate` — strict JSON parse (a malformed notebook is a validation failure; every other channel degrades to empty rather than throwing).

References are deferred: a notebook's imports/calls are kernel-language code, and classifying them would mean embedding a per-kernel parser — out of scope for v1.

## license

MIT.

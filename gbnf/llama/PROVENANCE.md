# llama/ provenance

Verbatim copies of the llama.cpp GBNF oracle sources. **Do not edit by hand** —
regenerate with `npm run build:fetchLlamaGrammar`. Adaptation toward llama-gbnf.c
happens in the build:llama step and is diffable against these originals.

- repo: https://github.com/ggml-org/llama.cpp
- pinned commit: `0d2d9ccbf6aae92de310712297fd52becc134092`
- drift gate: `npm run build:fetchLlamaGrammar` fails when `master` moves past this pin.

| file | sha256 |
| --- | --- |
| `src/llama-grammar.cpp` | `47d400b872a08fc18d7457535eb647bb70b7836d8a80a940554e934b4b6532c0` |
| `src/llama-grammar.h` | `db730e5aff77f96274aba4a43670f036400d89c7ed44b6e98d3ced41c7b9d193` |
| `src/unicode.cpp` | `aa75c6258a7e0d8ddc05476cbe68ce9baae99b8cf9ffad8a8ee545d176cb97da` |
| `src/unicode.h` | `f1562388d5b9d2dac1152ad8eda56e0bcae25dd407cf15d9dd2e96fe0124f4e7` |
| `src/unicode-data.cpp` | `95170cd1c105a5b41a1b2dce73b0fae8ce8011ef7897600828bb2babe8b26e5d` |
| `src/unicode-data.h` | `1854f4494e5666db6036f0bf4cf818e01588b40b48a89e3372e775c4d5174402` |
| `tests/test-gbnf-validator.cpp` | `21eb0bac296c0e0dd497cc438ab8f10ba9cad66488c00288321d939afbdf310f` |

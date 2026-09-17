# WHATWG URL corpus

`urltestdata.json` is the unmodified WPT corpus from
[web-platform-tests/wpt, commit c23755a](https://github.com/web-platform-tests/wpt/blob/c23755a1449cc9c5a9131378c13ecf073c0885c6/url/resources/urltestdata.json).
Its BSD-3-Clause license is included. This is test data, not a runtime input.

`url-wpt.test.ts` accounts for all 893 data cases under {§path-syntax}:

| Cases | Treatment |
|---:|---|
| 344 | Relative and non-`scheme://` spellings remain local paths; Plurnk has no base-URL resolution. |
| 21 | Explicit skips: raw newlines or `<` cannot inhabit a target header ({§path-parentheses}). |
| 528 | Decomposed through the public helper and a framed READ heading. 239 are expected failures. |

Within the 528 URI cases, one literal-brace pathname deliberately remains a glob
rather than becoming percent-encoded data. Eight malformed IDNA hostnames are
WPT-valid but rejected by Node 26.6's URL implementation. They follow the native
parser's refusal with a visible diagnostic, or the WPT result if the runtime
accepts them. The exceptions are an exact input set; unrelated failures cannot
enter it. No alternative IDNA implementation is introduced.

All other URI fields are compared with WPT's published expected values, not
values reconstructed by calling our own parser. The category and exception
counts are asserted, so updating the corpus requires reviewing its coverage.

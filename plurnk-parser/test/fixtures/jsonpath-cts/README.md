# JSONPath compliance corpus

`cts.json` and `LICENSE` are from the BSD-2-licensed
[JSONPath Compliance Test Suite](https://github.com/jsonpath-standard/jsonpath-compliance-test-suite/tree/9d1a415a53f5dfb291bc874823892e49174e38eb),
commit `9d1a415a53f5dfb291bc874823892e49174e38eb`. Only line endings are normalized.
The offline integration test enumerates all 706 cases, including invalid selectors.

The engine's RFC 9535 compile result and Plurnk's matcher admission are checked
separately. Plurnk's one-line matcher boundary rejects 87 multiline cases,
including 76 valid RFC selectors ({§pattern-body-single-line}). The one selector
beginning with a space does not claim JSONPath ({§matcher-prefix-claims}). Those
boundaries are asserted, not skipped or counted as RFC conformance passes.

The JSON pattern option transports the selector unchanged. The corpus and its
runner are test inputs, not published runtime data.

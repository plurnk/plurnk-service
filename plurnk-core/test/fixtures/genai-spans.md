# GenAI span audit

`observe-genai.test.ts` exercises normal inference, successful BARE inference,
and failed BARE inference through the real engine with deterministic providers.
The fixture covers provider-registry spellings, a custom endpoint, and an
unregistered handle. It does not test provider networking.

From `plurnk-core`, with OpenTelemetry Weaver 0.26.1 installed separately:

````sh
node --conditions=plurnk-dev --import=./test/setup.ts test/fixtures/genai-spans.ts > /tmp/plurnk-genai-spans.json
weaver registry live-check \
  --registry 'https://github.com/open-telemetry/semantic-conventions-genai.git@c88d504ab3d9879f8e50d3cc87e69775e11db234[model]' \
  --v2 --input-source /tmp/plurnk-genai-spans.json --input-format json \
  --format json --no-stream --output /tmp/plurnk-genai-report
````

The complete report is intentionally not filtered into a green result.
Against this pinned registry, the 33 spans produce these findings:

| Finding | Count | Interpretation |
|---|---:|---|
| `missing_attribute`, `missing_namespace` for `model`, `attempt`, `kind`, `status` | 110 each | Existing custom attributes, not claimed as standard attributes ({§observability-genai-conventions}). |
| `not_stable` on `gen_ai.*` | 165 | The approved GenAI projection uses development conventions. |
| `undefined_enum_variant` for `custom-endpoint` and `other` | 6 | Open-ended provider identities; custom and unknown are not misreported as a known vendor. |
| `missing_attribute` for `error.type` | 11 | The split GenAI registry's live-check projection omits this core-registry attribute. |

`--include-unreferenced` resolves `error.type`, with informational notices for
the application error class, but imports the core registry's deprecated copy of
`gen_ai.request.model` over the current GenAI definition. Neither result is a
reason to delete valid error evidence or the required model attribute.
Registry-format warnings concern upstream `definition/2` files; `--future`
promotes those warnings to errors before producing a clean command exit.

The local integration tests separately assert span names, required attributes,
usage values, error redaction, and call topology; the external checker is not
proof of those semantics. Weaver and its registry are not runtime dependencies
or mandatory push-gate installations.

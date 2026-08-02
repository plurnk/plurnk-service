// The ONE model-facing token ruler ({§tokenomics-agnostic-ruler}, owner ruling 2026-07-13).
//
// The daemon runs many workers on different models in one workspace at once (per-loop model selection,
// #414), and token accounting is workspace-wide (the catalog lists every workspace entry). A single
// "true" per-entry count is therefore a fiction — there is no one model to be true to — and
// exact tokenizers exist only for models with a bundled tokenizer.json (most frontier models
// degrade to this same chars ruler anyway). So the ENTIRE model-facing perspective — catalog
// costs, tokensFree, ceiling, and write-time stamps - uses this one
// model-INDEPENDENT ruler: one number per content, identical no matter which model reads it, no
// per-model state, trivially concurrent-safe.
//
// It is a conservative UPPER bound (ceil(chars/2) — the same heuristic mimetypes serves when no
// exact tokenizer resolves), so the model's whole ledger is coherent AND safe: "thinks it fits"
// ⟹ "really fits", at the cost of some window under-utilization (accepted). The provider's EXACT
// count is used only at packet materialization — one measurement of the assembled packet, per
// turn — to guarantee the real packet fits the shipping model's real window.
export const rulerCount = (text: string): number => Math.ceil(text.length / 2);

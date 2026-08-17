// Hermetic materializer fixture for the WebFetcher/Http unit tiers. The exported
// `__stub` control surface lets tests set the per-request behavior and inspect
// calls; the framework contract surface is the default export.

let behavior = {
    eligible: () => null,
    extract: async () => ({ outcome: "hard", identity: "stub-unset", evidence: [], problem: { status: 502, code: "stub-unset", detail: "no stub behavior configured", retryable: false } }),
};

export const __stub = {
    set(next) { behavior = next; },
    calls: [],
};

export default {
    get id() { return "stub"; },
    async eligible(url, ctx) {
        __stub.calls.push({ kind: "eligible", url });
        return behavior.eligible(url, ctx);
    },
    async extract(url, opts) {
        __stub.calls.push({ kind: "extract", url });
        return behavior.extract(url, opts);
    },
};

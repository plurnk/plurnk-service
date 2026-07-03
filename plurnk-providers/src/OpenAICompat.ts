// Shared OpenAI-compatible provider. Implements the universal generate()
// spine — signal merging, the SSE call, usage mapping, finishReason
// normalization, response assembly — that every sibling had duplicated.
//
// Composition, not inheritance: the per-provider deltas (resolved URL, auth
// headers, reasoning translation style, tokenizer, cost) arrive as config.
// A sibling's fromEnv probes whatever it needs (catalog, pricing, context
// window), builds the config, and returns `new OpenAICompatProvider(config)`.
// Pure-config providers come from ./standardProviders.ts with no sibling at all.

import type { ChatMessage, FinishReason, Provider, ProviderResponse, ProviderUsage } from "./types.ts";
import { chatCompletionStream, chatCompletion, OpenAiHttpError, type StreamResponse } from "./openaiStream.ts";
import { normalizeUsage } from "./usage.ts";
import { toProviderError, classifyProviderError, ProviderError, type TelemetryEvent } from "./telemetry.ts";
import { validateGbnf, type Verdict } from "@plurnk/gbnf";

// How the single reasoningBudget (PLURNK_PROVIDERS_REASONING_BUDGET: 0 off,
// -1 adaptive, N capped) translates to each backend's wire mechanism (SPEC §4);
// the per-style mapping lives in #reasoningBody. Non-obvious ones: "template"
// ALWAYS emits enable_thinking — the explicit false is llama-server's only working
// off-switch (§13); "anthropic" uses the `thinking` object and IGNORES reasoning_effort;
// "effort_explicit" (fireworks) sends the EXPLICIT "none"/"adaptive" enum values at
// 0/-1 instead of omitting — reason-by-DEFAULT models (DeepSeek V4 defaults 'high')
// keep reasoning when the field is omitted, fatal under an active grammar (#30).
export type ReasoningStyle = "none" | "think" | "include_reasoning" | "effort" | "effort_explicit" | "template" | "anthropic";

// How a caller-supplied GBNF grammar is carried on the wire — backends accept
// different shapes for the SAME GBNF (probed/configured, never guessed; §13); the
// wire shape per style lives in #grammarBody. "none" means the grammar is NOT sent
// (never silently — so a constrained consumer can't mistake unconstrained output
// for enforced).
export type GrammarStyle = "none" | "llamacpp" | "response_format";

export type OpenAICompatConfig = {
    model: string;
    url: string;                              // fully-resolved chat-completions URL
    fetchTimeoutMs: number;
    headers?: Record<string, string>;         // fully-resolved request headers (incl. auth); default {}
    contextSize?: number | null;              // default null
    reasoningStyle?: ReasoningStyle;          // default "none"
    countTokens?: (text: string) => number;   // default chars/4 heuristic
    costFor?: (usage: ProviderUsage) => number; // default () => 0
    source?: string;                           // telemetry source, e.g. "provider:openai"; default "provider"
    grammarStyle?: GrammarStyle;               // how a GBNF grammar is carried; default "none" (not sent)
    gbnfDebug?: boolean;                        // PLURNK_GBNF_DEBUG: validate the grammar locally + throw on invalid, but DON'T transport it (run unconstrained); default false
    streaming?: boolean;                        // SSE transport (default true); false → one non-streamed JSON
    firstPartyMetadata?: boolean;              // forward per-turn attributions + client as Plurnk-* headers (plurnk only); default false
    balanceMetaKey?: string;                    // top-level response field carrying account balance (pico-USD) → validated meta.balancePico (plurnk only, #23); default unset
    // Slot affinity wiring (provider-INTERNAL — never consumer-facing, #11).
    supportsSlotPinning?: boolean;             // backend accepts an `id_slot` body field (llama-server); default false
    slotCount?: number | null;                 // probed slot count for pinning backends; default null
    // Backend-served exact tokenization (llama-server /tokenize). When set, the
    // provider exposes the optional `tokenize()` capability — the model's OWN
    // vocab, no client-side tokenizer data needed; default unset (capability absent).
    tokenizeUrl?: string;
    // The side-channel reasoning budget — REQUIRED, no in-code default
    // (PLURNK_PROVIDERS_REASONING_BUDGET, read via reasoningBudgetFromEnv):
    // 0 off, -1 adaptive, N capped. The provider maps it to the backend's
    // mechanism via reasoningStyle.
    reasoningBudget: number;
    // Transient-failure retry budget — REQUIRED, no in-code default
    // (PLURNK_PROVIDERS_RETRY_ATTEMPTS, a non-negative int): 0 = surface the
    // first failure; N = up to N retries on a transient error (§4, #18).
    retryAttempts: number;
};

// Sampling guard under an active grammar (SPEC §13): greedy decoding under
// hard constraint masks degenerates into repetition loops at the server
// default of 1.0, so the floor rides per-request with every attached grammar —
// never rely on server launch flags. Probed on llama.cpp b894 + gemma-4-26B
// (plurnk-providers#9; reference: plurnk-grammar test/llama/gbnf-live.test.ts).
const GRAMMAR_REPEAT_PENALTY_FLOOR = 1.15;

// Near-greedy temperature DEFAULT for EVERY grammar path (#30, endpoint#7):
// measured on Fireworks DeepSeek V4, reasoning-off grammar runs went 2/5 → 30/30
// conformant-and-terminating adding temperature 0.2; the same ramble-inside-the-
// mask class reproduced on llama-server (whose launch default is 0.8 when the
// operator sets no --temp). Rides per-request like the repeat-penalty floor —
// never rely on server launch flags. A DEFAULT, not a floor — spread under the
// caller's `sampling`, so an explicit temperature wins (policy stays the
// consumer's; this only covers the no-sampling out-of-the-box call).
const GRAMMAR_TEMPERATURE = 0.2;

// Exponential-backoff base for transient-failure retries (#18). Attempt N waits
// RETRY_BASE_DELAY_MS * 2^(N-1), unless the server sent a Retry-After (which
// wins). The magnitude is mechanism, not operator intent — the COUNT is the
// knob (PLURNK_PROVIDERS_RETRY_ATTEMPTS); the base stays a constant.
const RETRY_BASE_DELAY_MS = 2000;

// Only these two classifications are transient and worth retrying: rate_limit
// (429) and network_failure (5xx, timeout, connection reset). unauthorized,
// quota_exceeded, invalid_response, model_refused are terminal — retrying just
// burns time and budget.
const RETRYABLE: ReadonlySet<string> = new Set(["rate_limit", "network_failure"]);

// Sleep that rejects the moment `signal` aborts (caller cancellation must not
// wait out a backoff). Resolves normally on timeout.
const sleepWithAbort = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });

// SPEC §2 closed set. Wire values outside it (provider-specific or absent)
// collapse to null — the consumer treats null as "no signal".
const FINISH_REASONS: ReadonlySet<string> = new Set(["stop", "length", "tool_calls", "content_filter"]);
const normalizeFinishReason = (raw: string | null): FinishReason =>
    raw !== null && FINISH_REASONS.has(raw) ? (raw as FinishReason) : null;

// Shared budget→effort breakpoints (xai and google had identical copies).
export const effortFromBudget = (budget: number): "low" | "medium" | "high" => {
    if (budget <= 1000) return "low";
    if (budget <= 4000) return "medium";
    return "high";
};

// chars/2 upper bound (see ./tokenizers.ts) — overcounts safely, never under.
const heuristicTokens = (text: string): number => (text.length === 0 ? 0 : Math.ceil(text.length / 2));

// Body keys the provider owns — a caller's `sampling` passthrough may not set
// these, or it could bypass grammar transport, the stream/JSON choice, or slot
// pinning (SPEC §8: backend-specific fields never cross the contract).
const RESERVED_BODY_KEYS: ReadonlySet<string> = new Set(["model", "messages", "stream", "stream_options", "grammar", "response_format", "id_slot"]);

// Render a non-accept verdict into a terse, factual grammar_unenforced message
// (SPEC §12 message policy: no guidance prose). `reject` names the diverging code
// point + what the grammar would have accepted; `incomplete` names the valid-prefix
// length that never reached a terminal state.
const describeUnenforced = (v: Exclude<Verdict, { status: "accept" }>): string => {
    if (v.status === "reject") {
        const expected = v.expected.length > 0
            ? v.expected.map((e) => `${e.rule} accepts ${e.accepts}`).join(", ")
            : "end of input";
        return `grammar not enforced: output rejected by the transported grammar at code point ${v.pos} (${JSON.stringify(v.char)}); expected ${expected}`;
    }
    return `grammar not enforced: output is an incomplete match of the transported grammar — a valid prefix of ${v.pos} code points that never terminated`;
};

export default class OpenAICompatProvider implements Provider {
    #model: string;
    #url: string;
    #fetchTimeoutMs: number;
    #headers: Record<string, string>;
    #contextSize: number | null;
    #reasoningBudget: number;
    #reasoningStyle: ReasoningStyle;
    #countTokens: (text: string) => number;
    #costFor: (usage: ProviderUsage) => number;
    #source: string;
    #grammarStyle: GrammarStyle;
    #gbnfDebug: boolean;
    #streaming: boolean;
    #firstPartyMetadata: boolean;
    #balanceMetaKey: string | undefined;
    #supportsSlotPinning: boolean;
    #slotCount: number | null;
    #retryAttempts: number;

    // Optional capability (SPEC §2): exact tokenization served by the backend's
    // own vocab. Assigned in the constructor ONLY when the config carries a
    // tokenizeUrl (llama-server), so `provider.tokenize === undefined` remains
    // the honest capability signal for every other backend.
    tokenize?: (text: string) => Promise<number[]>;

    constructor(config: OpenAICompatConfig) {
        this.#model = config.model;
        this.#url = config.url;
        this.#fetchTimeoutMs = config.fetchTimeoutMs;
        this.#headers = config.headers ?? {};
        this.#contextSize = config.contextSize ?? null;
        this.#reasoningBudget = config.reasoningBudget;
        this.#retryAttempts = config.retryAttempts;
        this.#reasoningStyle = config.reasoningStyle ?? "none";
        this.#countTokens = config.countTokens ?? heuristicTokens;
        this.#costFor = config.costFor ?? (() => 0);
        this.#source = config.source ?? "provider";
        this.#grammarStyle = config.grammarStyle ?? "none";
        this.#gbnfDebug = config.gbnfDebug ?? false;
        this.#streaming = config.streaming ?? true;
        this.#firstPartyMetadata = config.firstPartyMetadata ?? false;
        this.#balanceMetaKey = config.balanceMetaKey;
        this.#supportsSlotPinning = config.supportsSlotPinning ?? false;
        this.#slotCount = config.slotCount ?? null;
        const { tokenizeUrl } = config;
        if (tokenizeUrl !== undefined) {
            this.tokenize = async (text: string): Promise<number[]> => {
                const res = await fetch(tokenizeUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...this.#headers },
                    body: JSON.stringify({ content: text }),
                    signal: AbortSignal.timeout(this.#fetchTimeoutMs),
                });
                if (!res.ok) throw new Error(`${this.#source}: tokenize endpoint returned ${res.status}`);
                const { tokens } = (await res.json()) as { tokens?: unknown };
                if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === "number")) {
                    throw new Error(`${this.#source}: tokenize endpoint returned no token array`);
                }
                return tokens;
            };
        }
    }

    get contextSize(): number | null { return this.#contextSize; }
    get model(): string { return this.#model; }

    countTokens(text: string): number { return this.#countTokens(text); }
    costFor(usage: ProviderUsage): number { return this.#costFor(usage); }

    #reasoningBody(): Record<string, unknown> {
        const b = this.#reasoningBudget;   // 0 off, -1 adaptive, N>0 capped
        const on = b !== 0;
        switch (this.#reasoningStyle) {
            // Native-channel styles. "template" ALWAYS emits — the explicit
            // enable_thinking:false is the only working off-switch on
            // llama-server (§13). The magnitude is irrelevant for native (on/off only).
            case "template": return { chat_template_kwargs: { enable_thinking: on } };
            case "think": return on ? { think: true } : {};
            case "include_reasoning": return on ? { include_reasoning: true } : {};
            // effort tiers from a capped budget; adaptive (-1) omits the field
            // (lets the API pick its default depth); off (0) omits.
            case "effort": return b > 0 ? { reasoning_effort: effortFromBudget(b) } : {};
            // Fireworks enum (low|medium|high|xhigh|max|none|adaptive): 0 and -1
            // are sent EXPLICITLY — omission leaves a reason-by-default model
            // (DeepSeek V4: default 'high') reasoning inside a constrained decode
            // until max_tokens (#30, measured 0/5 → 30/30 conformant with "none").
            // V4 gotchas: integer efforts 400; low/medium silently promote to high.
            case "effort_explicit": return b === 0
                ? { reasoning_effort: "none" }
                : b > 0 ? { reasoning_effort: effortFromBudget(b) } : { reasoning_effort: "adaptive" };
            // Anthropic compat: explicit thinking object. 0 → disabled; N>0 →
            // enabled with budget_tokens; -1 adaptive → omit (the API default).
            case "anthropic": return b === 0
                ? { thinking: { type: "disabled" } }
                : b > 0 ? { thinking: { type: "enabled", budget_tokens: b } } : {};
            case "none": return {};
        }
    }

    // Per-run slot affinity (#11): the consumer passes WHICH run this is; the
    // provider owns WHICH slot serves it. Sticky per runId, round-robin across
    // new runs (distinct runs → distinct slots while slots last), LRU-bounded
    // bookkeeping so a long-lived daemon never grows the map unboundedly —
    // an evicted-and-returning run simply re-pins, worst case one cold prefill.
    #runSlots = new Map<string, number>();
    #nextSlot = 0;

    #slotBody(runId: string): Record<string, unknown> {
        if (!this.#supportsSlotPinning || this.#slotCount === null || this.#slotCount < 1) return {};
        let slot = this.#runSlots.get(runId);
        if (slot === undefined) {
            slot = this.#nextSlot++ % this.#slotCount;
            if (this.#runSlots.size >= this.#slotCount * 8) {
                this.#runSlots.delete(this.#runSlots.keys().next().value as string);
            }
        } else {
            this.#runSlots.delete(runId); // re-insert to refresh LRU recency
        }
        this.#runSlots.set(runId, slot);
        return { id_slot: slot };
    }

    // Grammar transport (SPEC §13): carry the caller-supplied GBNF in the shape
    // the backend accepts. Same grammar, different wire field per backend; an
    // unsupported/unknown backend sends NO field at all (cloud APIs 400 on
    // unknowns, and a silent send would let a constrained consumer mistake
    // unconstrained output for enforced).
    #grammarBody(grammar: string | undefined): Record<string, unknown> {
        if (grammar === undefined) return {};
        switch (this.#grammarStyle) {
            // Greedy decoding under hard constraint loops without a repeat-penalty
            // floor (#9, SPEC §13) — every grammar path carries it. llama.cpp spells
            // it `repeat_penalty`; the OpenAI-compat (Fireworks) shape is `repetition_penalty`
            // (verified honored live, #20).
            case "llamacpp": return { grammar, repeat_penalty: GRAMMAR_REPEAT_PENALTY_FLOOR };
            case "response_format": return { response_format: { type: "grammar", grammar }, repetition_penalty: GRAMMAR_REPEAT_PENALTY_FLOOR };
            case "none": return {};
        }
    }

    // First-party telemetry headers (SPEC §5): forwarded ONLY when the spec
    // opted in (the plurnk endpoint). The gate is here, not at the call site, so
    // attributions/client/strikes can never reach a third-party backend even if
    // the consumer passes them to the wrong provider. Empty values emit no header
    // — EXCEPT strikes, where 0 is a real value (clean streak) distinct from
    // absent (consumer didn't report); contract per plurnk-service#313. Strikes
    // ride HTTP headers only — the packet never carries them (the model must
    // never see strike state; engine accounting is not a metric to game).
    #metadataHeaders(attributions: string[] | undefined, client: string | undefined, strikes: number | undefined, runId: string): Record<string, string> {
        if (!this.#firstPartyMetadata) return {};
        const h: Record<string, string> = {};
        if (attributions !== undefined && attributions.length > 0) h["Plurnk-Attribution"] = JSON.stringify(attributions);
        if (client !== undefined && client.length > 0) h["Plurnk-Client"] = client;
        if (strikes !== undefined && Number.isInteger(strikes) && strikes >= 0) h["Plurnk-Strikes"] = String(strikes);
        // Run identity (#26): the opaque runId the consumer already supplies,
        // forwarded so the endpoint can key per-run affinity/telemetry — same
        // gate as every first-party signal.
        h["Plurnk-Run-Id"] = runId;
        return h;
    }

    // Enforcement verification (SPEC §13). When a grammar was actually transported
    // (grammarStyle !== "none"), the backend MUST have constrained the output;
    // some silently drop the grammar field or mislabel the channel, and without
    // this check we would return unconstrained output as if enforced. STRICT: any
    // non-accept verdict (reject, or an incomplete/never-terminated match) is a
    // grammar_unenforced failure. A grammar our own validator can't parse — even
    // though the backend accepted it (a port-vs-llama.cpp gap) — is a non-fatal
    // verify gap: warn, don't fail a transport that may have worked. This is a
    // conformance check against the grammar we already hold, NOT a plurnk-DSL
    // parse (§8) — it stays grammar-generic and backend-agnostic.
    // Validate output against the grammar. Returns the verdict, or null on the
    // verify GAP — a grammar our own validator can't parse (a port-vs-llama.cpp
    // gap): warn, don't manufacture a conflict from a check that didn't run.
    #grammarVerdict(grammar: string, content: string): Verdict | null {
        try {
            return validateGbnf(grammar, content);
        } catch (cause) {
            process.emitWarning(
                `${this.#source}: could not verify grammar enforcement — the transported grammar did not parse in @plurnk/gbnf (${(cause as Error).message})`,
                { code: "PLURNK_GRAMMAR_UNVERIFIABLE" },
            );
            return null;
        }
    }

    // CONSTRAINED path (grammar transported, grammarStyle !== "none"): the backend
    // MUST have constrained the output — some silently drop the grammar field or
    // mislabel the channel. STRICT: any non-accept verdict throws a terminal
    // grammar_unenforced ProviderError. A conformance check against the grammar we
    // already hold, NOT a plurnk-DSL parse (§8) — backend-agnostic. The rejected
    // attempt's content + normalized usage ride the error (#31): the consumer
    // billed for the discarded emission and lost its bytes — a 33k-char verdict
    // offset was once the only forensic window into what a model actually said.
    #verifyGrammarEnforced(grammar: string, raw: StreamResponse): void {
        const verdict = this.#grammarVerdict(grammar, raw.content);
        if (verdict === null || verdict.status === "accept") return;
        throw new ProviderError(this.#source, "grammar_unenforced", describeUnenforced(verdict), {
            attempt: { content: raw.content, usage: normalizeUsage(raw.usage) },
        });
    }

    // GBNF-FILTER path (PLURNK_GBNF_DEBUG: grammar withheld, output validated after
    // the fact). Non-conformance is EXPECTED here, so it does NOT throw — it returns
    // a non-fatal grammar_unenforced TelemetryEvent carrying the divergence position
    // (the model's bytes ride the response, not the message), so the consumer can
    // render the model its own emission around `position` and let it self-correct
    // (#24). null when the output conforms or the verify gap fired.
    #grammarConflictEvent(grammar: string, content: string): TelemetryEvent | null {
        const verdict = this.#grammarVerdict(grammar, content);
        if (verdict === null || verdict.status === "accept") return null;
        return { source: this.#source, kind: "grammar_unenforced", message: describeUnenforced(verdict), position: verdict.pos };
    }

    // PLURNK_GBNF_DEBUG (SPEC §13): validate the supplied GBNF locally and fail
    // hard if it's malformed, BEFORE any wire call — and the grammar is NOT
    // transported, so the request runs unconstrained. A debug aid to catch invalid
    // grammars (e.g. while editing the plurnk grammar) without a model round-trip;
    // off in production. `validateGbnf(grammar, "")` parses the grammar + resolves
    // its root, throwing iff the grammar itself is invalid (the empty input's
    // verdict is irrelevant — we only care that parsing succeeded).
    #assertGrammarValid(grammar: string): void {
        try {
            validateGbnf(grammar, "");
        } catch (cause) {
            throw new Error(`grammar validation (PLURNK_GBNF_DEBUG): invalid GBNF — ${(cause as Error).message}`, { cause });
        }
    }

    // Per-turn metadata bag (#23): pass the backend's non-standard top-level fields
    // (the transport's `chunkMetadata`) through VERBATIM, then normalize the known
    // keys we hold a contract for — the spec's balance field → a validated
    // `balancePico` (finite pico-USD; dropped if non-numeric), renamed off its raw
    // key so the consumer reads one canonical name. Undefined when nothing's there;
    // the service merges this into its Turn metadata and filters what reaches clients.
    #buildMeta(chunkMetadata: Record<string, unknown>): Record<string, unknown> | undefined {
        const meta: Record<string, unknown> = { ...chunkMetadata };
        if (this.#balanceMetaKey !== undefined) {
            const raw = meta[this.#balanceMetaKey];
            delete meta[this.#balanceMetaKey];
            if (typeof raw === "number" && Number.isFinite(raw)) meta.balancePico = raw;
        }
        return Object.keys(meta).length > 0 ? meta : undefined;
    }

    // Caller-supplied OpenAI-compat sampling params (temperature, top_p, top_k,
    // penalties, stop, seed, …) merged UNDER the managed body: model, messages,
    // reasoning, grammar (+ its repeat-penalty floor), max_tokens and slot always
    // win, and reserved transport/protocol keys are stripped so the passthrough
    // can't smuggle a grammar, a stream toggle, or a backend slot (SPEC §8).
    #samplingBody(sampling: Record<string, unknown> | undefined): Record<string, unknown> {
        if (sampling === undefined) return {};
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(sampling)) if (!RESERVED_BODY_KEYS.has(k)) out[k] = v;
        return out;
    }

    async generate({ messages, runId, signal, grammar, maxTokens, attributions, client, strikes, sampling }: { messages: ChatMessage[]; runId: string; signal?: AbortSignal; grammar?: string; maxTokens?: number; attributions?: string[]; client?: string; strikes?: number; sampling?: Record<string, unknown> }): Promise<ProviderResponse> {
        // Boundary validation (SPEC §2): the run identity is required.
        if (runId === undefined || runId.length === 0) throw new Error("generate: runId is required — the run's stable, opaque identity");
        // Reject before any wire call when already aborted (SPEC §10.8).
        signal?.throwIfAborted();

        // Grammar handling (SPEC §13). PLURNK_GBNF_DEBUG validates the supplied
        // grammar locally and throws on a malformed one, then WITHHOLDS it so the
        // model generates UNCONSTRAINED — and the free output is still verified
        // against the grammar (below), surfacing exactly where the model's natural
        // output and the grammar conflict. Otherwise the grammar is sent when the
        // backend supports it (grammarStyle !== "none").
        const wantGrammar = grammar !== undefined && this.#grammarStyle !== "none";
        if (wantGrammar && this.#gbnfDebug) this.#assertGrammarValid(grammar!);
        const sendGrammar = wantGrammar && !this.#gbnfDebug ? grammar : undefined;

        // Assembly order = precedence: grammar-path sampling DEFAULTS (any
        // transported grammar needs a near-greedy decode, #30) < the caller's
        // `sampling` < the managed fields (model/messages/reasoning/grammar/
        // max_tokens/slot), which always win.
        const grammarSamplingDefaults: Record<string, unknown> =
            sendGrammar !== undefined ? { temperature: GRAMMAR_TEMPERATURE } : {};
        const body: Record<string, unknown> = {
            ...grammarSamplingDefaults,
            ...this.#samplingBody(sampling),
            model: this.#model,
            messages,
            ...this.#reasoningBody(),
            ...this.#grammarBody(sendGrammar),
            ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
            ...this.#slotBody(runId),
        };

        // Transient-failure retry (#18). Each attempt gets a FRESH fetch timeout
        // (the budget is per-request, not shared across retries); the caller's
        // signal spans them all. Retry only the transient classifications, prefer
        // a server Retry-After over the backoff, and let the caller's abort cut
        // through both the in-flight request and the backoff sleep.
        // Stream by default, but fall back to one non-streamed JSON for the one
        // case it breaks: a response_format grammar (fireworks) streams its
        // constrained output mislabeled as reasoning_content, yet returns it as
        // content non-streamed. The atomic dump is correct either way, so the
        // demotion is scoped to exactly that request, not the whole provider.
        const grammarBreaksStream = sendGrammar !== undefined && this.#grammarStyle === "response_format";
        const transport = this.#streaming && !grammarBreaksStream ? chatCompletionStream : chatCompletion;

        // Per-request headers = static auth/routing + any first-party telemetry.
        const metaHeaders = this.#metadataHeaders(attributions, client, strikes, runId);
        const headers = Object.keys(metaHeaders).length > 0 ? { ...this.#headers, ...metaHeaders } : this.#headers;
        let raw;
        for (let attempt = 0; ; attempt++) {
            const timeoutSignal = AbortSignal.timeout(this.#fetchTimeoutMs);
            const effectiveSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
            try {
                raw = await transport({ url: this.#url, headers, body, signal: effectiveSignal });
                break;
            } catch (err) {
                // Caller-initiated abort is cancellation — never retried or wrapped.
                if (signal?.aborted) throw err;
                const { kind } = classifyProviderError(err);
                // Terminal kind, or budget spent → surface the classified failure.
                if (!RETRYABLE.has(kind) || attempt >= this.#retryAttempts) throw toProviderError(err, this.#source);
                const retryAfter = err instanceof OpenAiHttpError ? err.retryAfter : null;
                await sleepWithAbort(retryAfter ?? RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
            }
        }

        // Grammar conformance (§13). Two paths from one check, splitting on whether
        // we actually transported the grammar:
        //   - CONSTRAINED (sendGrammar): the backend was told to enforce → a non-accept
        //     verdict is a hard failure, THROW grammar_unenforced before the content
        //     reaches the consumer.
        //   - FILTER (PLURNK_GBNF_DEBUG): grammar withheld, model ran unconstrained →
        //     non-conformance is expected diagnostic, NOT a failure. Attach it as a
        //     non-fatal telemetry event so the model's bytes still flow and the
        //     consumer can feed the divergence back for self-correction (#24).
        let telemetry: TelemetryEvent[] | undefined;
        if (sendGrammar !== undefined) {
            this.#verifyGrammarEnforced(sendGrammar, raw);
        } else if (wantGrammar && this.#gbnfDebug) {
            const event = this.#grammarConflictEvent(grammar!, raw.content);
            if (event !== null) telemetry = [event];
        }

        const meta = this.#buildMeta(raw.chunkMetadata);

        return {
            assistant: {
                content: raw.content,
                reasoning: raw.reasoning_content.length > 0 ? raw.reasoning_content : null,
                usage: normalizeUsage(raw.usage),
                finishReason: normalizeFinishReason(raw.finish_reason),
                model: raw.model ?? this.#model,
            },
            assistantRaw: raw,
            ...(meta !== undefined ? { meta } : {}),
            ...(telemetry !== undefined ? { telemetry } : {}),
        };
    }
}

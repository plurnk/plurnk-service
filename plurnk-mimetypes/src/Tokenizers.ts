import type { HandlerLoader } from "./Mimetypes.ts";
import type { TelemetryEvent } from "./TelemetryEvent.ts";

// Opt-in tokenizer artifact package (SPEC §19, #44): resolved lazily via the
// same loader handler packages use — the framework ships no vocab data. Kept
// separate from the embeddings package so window math never forces a deployment
// to carry MiniLM ONNX weights (the providers#27 weight-granularity lesson).
const TOKENIZERS_PACKAGE = "@plurnk/plurnk-mimetypes-tokenizers";

// The duck surface the tokenizers package must export (SPEC §19).
interface TokenizersArtifact {
    // modelRef → exact counter, or null when no bundled tokenizer matches the
    // ref (an unknown model is a DATA gap, not an error — the seam degrades).
    resolve(modelRef: string): Promise<{ countTokens(text: string): Promise<number>; tokenizerId: string } | null>;
    // Release any native/WASM engine state; absent → nothing to tear down.
    dispose?(): Promise<void> | void;
}

// What tokenizer() hands the host (SPEC §19, #44). ALWAYS returns a usable
// counter — exact when a bundled tokenizer matches, else the chars/2 upper
// bound with `exact: false` and a `tokenizer_unavailable` warn event. Never a
// silent estimate: a degraded resolution is visibly degraded on the shape.
export interface TokenizerResolution {
    countTokens(text: string): Promise<number>;
    // Identity of the VOCAB, not the model (#44): sha256 of the tokenizer.json
    // for exact resolutions (two models sharing a vocab share the id, so a
    // model swap that keeps the vocab never invalidates derived counts);
    // "heuristic:chars2" for the degraded upper bound.
    readonly tokenizerId: string;
    readonly exact: boolean;
    // Present iff degraded — the host forwards into packet telemetry (SPEC §11.5).
    readonly telemetry?: readonly TelemetryEvent[];
}

// chars/2 upper bound (providers#44 measurement: real agentic text runs
// 2.9–3.2 chars/token, so /2 over-reserves — the SAFE direction for window
// math; the old /4 silently under-counted 20–27%, the dangerous direction).
function charsUpperBound(text: string): number {
    return Math.ceil(text.length / 2);
}

function degraded(modelRef: string, reason: string, extra: Record<string, unknown>): TokenizerResolution {
    return {
        countTokens: (text) => Promise.resolve(charsUpperBound(text)),
        tokenizerId: "heuristic:chars2",
        exact: false,
        telemetry: [{
            source: "tokenizer",
            kind: "tokenizer_unavailable",
            level: "warn",
            message: `No exact tokenizer for ${JSON.stringify(modelRef)} (${reason}); `
                + `counting with the chars/2 upper bound.`,
            position: null,
            model: modelRef,
            ...extra,
        }],
    };
}

// The framework's single tokenizer seam (SPEC §19, #44), parallel to
// Embeddings.ts: owns the opt-in tokenizers package's lifecycle — lazy
// resolution, per-model exact counters, the honest degrade — so the host
// (which composes this after the provider's own tokenize() capability)
// never reaches the package directly.
export default class Tokenizers {
    readonly #loader: HandlerLoader;
    // Primed-promise cache: null result = package not installed; the promise is
    // cached so the artifact loads once per orchestrator lifetime.
    #promise: Promise<TokenizersArtifact | null> | null = null;

    constructor(loader: HandlerLoader) {
        this.#loader = loader;
    }

    // modelRef → TokenizerResolution (SPEC §19). Resolution chain per #44:
    // bundled tokenizer.json matched by model ref → exact counter + vocab-sha
    // id; package missing OR no match → chars/2 upper bound + a
    // `tokenizer_unavailable` warn event naming the model (strict throws).
    async tokenizer(modelRef: string, options: { strict?: boolean } = {}): Promise<TokenizerResolution> {
        const artifact = await this.#resolve();
        if (artifact === null) {
            if (options.strict) {
                throw new Error(
                    `Exact tokenizer requested for ${JSON.stringify(modelRef)} but ${TOKENIZERS_PACKAGE} `
                    + `is not installed. npm install ${TOKENIZERS_PACKAGE} to enable it.`,
                );
            }
            return degraded(modelRef, "package not installed", { plurnkPackage: TOKENIZERS_PACKAGE });
        }
        const hit = await artifact.resolve(modelRef);
        if (hit === null) {
            if (options.strict) {
                throw new Error(
                    `Exact tokenizer requested for ${JSON.stringify(modelRef)} but ${TOKENIZERS_PACKAGE} `
                    + `bundles no tokenizer matching that ref.`,
                );
            }
            return degraded(modelRef, "no bundled tokenizer matches", {});
        }
        return {
            countTokens: (text) => hit.countTokens(text),
            tokenizerId: hit.tokenizerId,
            exact: true,
        };
    }

    #resolve(): Promise<TokenizersArtifact | null> {
        this.#promise ??= (async () => {
            let mod: unknown;
            try {
                mod = await this.#loader(TOKENIZERS_PACKAGE);
            } catch (err) {
                // Package genuinely absent → null → chars/2 degrade. Any OTHER
                // load error means the artifact IS installed but threw on import
                // — a misconfiguration, never silently downgraded to "absent"
                // (the Embeddings.ts lesson, verbatim).
                const code = (err as { code?: string })?.code;
                if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return null;
                throw err;
            }
            const m = mod as { resolve?: unknown; default?: { resolve?: unknown } };
            const surface = typeof m.resolve === "function" ? m : m.default;
            if (typeof surface?.resolve !== "function") return null;
            return surface as unknown as TokenizersArtifact;
        })();
        return this.#promise;
    }

    // Release the artifact's engine state (if it holds any); idempotent,
    // re-lazy-inits if used again. Forwarded from Mimetypes.dispose().
    async dispose(): Promise<void> {
        if (this.#promise === null) return;
        const pending = this.#promise;
        this.#promise = null;
        try {
            const artifact = await pending;
            if (artifact && typeof artifact.dispose === "function") await artifact.dispose();
        } catch {
            // artifact never loaded (package absent / load failed) — nothing to release.
        }
    }
}

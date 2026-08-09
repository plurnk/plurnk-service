import type { HandlerLoader } from "./Mimetypes.ts";
import type { Notice } from "./Notice.ts";
import { isExactModuleAbsent } from "./module-absence.ts";

// Fixed tokenizer artifact seam, resolved lazily ({§mimetype-tokenizer}).
const TOKENIZERS_PACKAGE = "@plurnk/plurnk-mimetypes-tokenizers";

// Internal artifact boundary; the public surface is TokenizerResolution.
interface TokenizersArtifact {
    // null means the artifact has no matching vocabulary.
    resolve(modelRef: string): Promise<{
        countTokens(text: string, options?: TokenCountOptions): Promise<number>;
        tokenizerId: string;
    } | null>;
    dispose?(): Promise<void> | void;
}

export interface TokenCountOptions {
    signal?: AbortSignal;
}

// Exactness and vocabulary identity remain explicit on every resolution
// ({§mimetype-tokenizer}).
export interface TokenizerResolution {
    countTokens(text: string, options?: TokenCountOptions): Promise<number>;
    // Vocabulary identity, or the stable degraded-estimator identity.
    readonly tokenizerId: string;
    readonly exact: boolean;
    // Present iff degraded.
    readonly notices?: readonly Notice[];
}

// Empirical fallback only; #95 owns a correctness-safe chunk-admission policy.
function charsEstimate(text: string): number {
    return Math.ceil(text.length / 2);
}

function degraded(modelRef: string, reason: string, extra: Record<string, unknown>): TokenizerResolution {
    return {
        countTokens: (text, options) => {
            options?.signal?.throwIfAborted();
            return Promise.resolve(charsEstimate(text));
        },
        tokenizerId: "heuristic:chars2",
        exact: false,
        notices: [{
            source: "tokenizer",
            kind: "tokenizer_unavailable",
            level: "warn",
            message: `No exact tokenizer for ${JSON.stringify(modelRef)} (${reason}); `
                + `counting with the degraded chars/2 estimate.`,
            position: null,
            model: modelRef,
            ...extra,
        }],
    };
}

// Owns lazy artifact resolution and lifecycle ({§mimetype-tokenizer}).
export default class Tokenizers {
    readonly #loader: HandlerLoader;
    // Primed-promise cache: null result = package not installed; the promise is
    // cached so the artifact loads once per orchestrator lifetime.
    #promise: Promise<TokenizersArtifact | null> | null = null;

    constructor(loader: HandlerLoader) {
        this.#loader = loader;
    }

    // Match exactly or return an explicit estimate; strict rejects degradation.
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
            countTokens: (text, countOptions) => hit.countTokens(text, countOptions),
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
                if (isExactModuleAbsent(err, TOKENIZERS_PACKAGE)) return null;
                throw err;
            }
            const m = mod as { resolve?: unknown; default?: { resolve?: unknown } };
            const surface = typeof m.resolve === "function" ? m : m.default;
            if (typeof surface?.resolve !== "function") {
                throw new TypeError(`${TOKENIZERS_PACKAGE} does not implement resolve()`);
            }
            return surface as unknown as TokenizersArtifact;
        })();
        return this.#promise;
    }

    // Idempotent cache teardown; later use resolves lazily again.
    async dispose(): Promise<void> {
        if (this.#promise === null) return;
        const pending = this.#promise;
        this.#promise = null;
        const artifact = await pending;
        if (artifact && typeof artifact.dispose === "function") await artifact.dispose();
    }
}

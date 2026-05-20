import fs from "node:fs/promises";
import { detect } from "./detect.ts";
import { discover } from "./discover.ts";
import { fitContent } from "./fit.ts";
import type BaseHandler from "./BaseHandler.ts";
import type {
    DetectInput,
    DiscoverOptions,
    Discovery,
    HandlerMetadata,
    HandlerOptions,
    TokenizeFn,
} from "./types.ts";

// No default budget in the helper. plurnk-service owns the real default
// (PLURNK_ENTRY_SIZE_DEFAULT_TOKENS, runtime env, currently 256 tokens for the
// channel preview portal) and passes it per call. When budget is unspecified
// here, preview is unbounded — equivalent to symbols. Baking a fallback number
// would silently shadow the env var and create drift when plurnk-service
// changes its default.
const UNBOUNDED_BUDGET = Number.POSITIVE_INFINITY;

const defaultTokenize: TokenizeFn = async (text) => Math.ceil(text.length / 2);

// Loader hook: how to resolve a handler package to its default-exported class.
// Production uses dynamic import(); tests inject a custom loader to avoid
// touching the module system.
export type HandlerLoader = (packageName: string) => Promise<unknown>;

const defaultLoader: HandlerLoader = (packageName) => import(packageName);

export interface MimetypesOptions {
    tokenize?: TokenizeFn;
    discoverOptions?: DiscoverOptions;
    // Pre-built discovery — bypasses the filesystem scan. Useful for tests and
    // for consumers that build their registry programmatically.
    discovery?: Discovery;
    loader?: HandlerLoader;
}

export interface ProcessInput {
    path?: string;
    content?: string;
    ext?: string;
    hint?: string;
}

export interface ProcessOptions {
    budget?: number;
}

export interface ProcessResult {
    mimetype: string | null;
    symbols: string;
    preview: string;
    ok: boolean;
}

// Top-level orchestrator. Plurnk-service constructs one of these at boot,
// injecting its tokenize function. process(path) is the primary entry point;
// detect() and getHandler() are exposed for callers that want to drive the
// pipeline manually.
export default class Mimetypes {
    readonly #tokenize: TokenizeFn;
    readonly #discoverOptions: DiscoverOptions;
    readonly #loader: HandlerLoader;
    readonly #handlerInstances = new Map<string, BaseHandler>();
    #discovery: Discovery | null = null;
    #readyPromise: Promise<void> | null = null;

    constructor(options: MimetypesOptions = {}) {
        this.#tokenize = options.tokenize ?? defaultTokenize;
        this.#discoverOptions = options.discoverOptions ?? {};
        this.#loader = options.loader ?? defaultLoader;
        if (options.discovery !== undefined) this.#discovery = options.discovery;
    }

    // Eagerly run discovery. Safe to call multiple times — subsequent calls
    // share the same in-flight promise. Optional: every public method that
    // needs discovery awaits this internally.
    async ready(): Promise<void> {
        if (this.#discovery !== null) return;
        if (this.#readyPromise !== null) return this.#readyPromise;
        this.#readyPromise = (async () => {
            this.#discovery = await discover(this.#discoverOptions);
        })();
        return this.#readyPromise;
    }

    async detect(input: DetectInput): Promise<string | null> {
        await this.ready();
        return detect(input, this.#discovery!.registry);
    }

    async getHandler(mimetype: string): Promise<BaseHandler | null> {
        await this.ready();

        const cached = this.#handlerInstances.get(mimetype);
        if (cached !== undefined) return cached;

        const info = this.#discovery!.handlers.get(mimetype);
        if (info === undefined) return null;

        let mod: unknown;
        try {
            mod = await this.#loader(info.packageName);
        } catch {
            return null;
        }

        if (typeof mod !== "object" || mod === null) return null;
        const HandlerClass = (mod as { default?: unknown }).default;
        if (typeof HandlerClass !== "function") return null;

        const metadata: HandlerMetadata = {
            mimetype: info.mimetype,
            glyph: info.glyph,
            extensions: info.extensions,
        };
        const handlerOptions: HandlerOptions = { tokenize: this.#tokenize };
        const Ctor = HandlerClass as new (m: HandlerMetadata, o: HandlerOptions) => BaseHandler;
        const handler = new Ctor(metadata, handlerOptions);

        this.#handlerInstances.set(mimetype, handler);
        return handler;
    }

    // The pipeline. Detection -> content read -> handler resolve -> validate ->
    // extract -> symbols -> preview. Errors are routed per policy:
    //   * detection fails or content read fails -> ok:false, empty strings
    //   * handler missing -> ok:false, raw-content preview as fallback
    //   * validate throws -> propagates (caller's contract; bug in content or handler)
    //   * extract throws -> contained inside handler -> empty symbols -> raw fallback
    async process(input: ProcessInput, options: ProcessOptions = {}): Promise<ProcessResult> {
        const budget = options.budget ?? UNBOUNDED_BUDGET;
        const mimetype = await this.detect(input);

        if (mimetype === null) {
            return { mimetype: null, symbols: "", preview: "", ok: false };
        }

        const content = await this.#resolveContent(input);
        if (content === null) {
            return { mimetype, symbols: "", preview: "", ok: false };
        }

        const handler = await this.getHandler(mimetype);
        if (handler === null) {
            const preview = await fitContent(content, budget, this.#tokenize);
            return { mimetype, symbols: "", preview, ok: false };
        }

        // Validate errors propagate per error policy — caller's contract.
        handler.validate(content);

        const symbols = handler.symbols(content);
        let preview = await handler.preview(content, budget);
        if (preview === "" && content !== "") {
            preview = await fitContent(content, budget, this.#tokenize);
        }

        return { mimetype, symbols, preview, ok: true };
    }

    async #resolveContent(input: ProcessInput): Promise<string | null> {
        if (input.content !== undefined) return input.content;
        if (input.path === undefined || input.path === "") return null;
        try {
            return await fs.readFile(input.path, "utf-8");
        } catch {
            return null;
        }
    }
}

import { discover } from "@plurnk/plurnk-execs";
import type { ChannelDecl, ExecArgs, ExecResult, Effect, RuntimeAvailability, ExecutorMetadata } from "@plurnk/plurnk-execs";
import PluginAttribution from "./plugin-attribution.ts";
import type { SchemeManifest } from "./types.ts";

// The executor contract surface we consume (a BaseExecutor subclass). We bind
// to the contract, not the framework's class identity. #240 — the executor is also
// the scheme face for its output, so it exposes `manifest` (OutputScheme-derived,
// name = the tag) + `defaultChannel`.
export interface Executor {
    readonly runtime: string;
    readonly glyph: string;
    get manifest(): SchemeManifest;
    get defaultChannel(): string;
    get channels(): Readonly<Record<string, ChannelDecl>>;
    run(args: ExecArgs): Promise<ExecResult>;
    probe(): Promise<RuntimeAvailability>;
    effect(target: string | null): Effect;
}

export interface RegistryEntry {
    readonly executor: Executor;
    readonly glyph: string;
    // One-line self-documenting usage example for the tag (plurnk-execs#7),
    // surfaced in the ## Plurnk System Tools sheet. "" when the package omits it.
    readonly example: string;
    // Fuller reference doc for the tag (plurnk-execs ExecInfo.documentation), materialized
    // at plurnk:///docs/<tag>.md and linked from the tools sheet. "" when the package omits it. #note12
    readonly documentation: string;
    readonly available: boolean;
    readonly detail: string | undefined;
}

// Boot-time runtime registry. Discovers installed @plurnk/plurnk-execs-*
// siblings (plurnk.kind:"exec") and probes each runtime TAG independently —
// one executor instance per tag (this.runtime = the tag), so a multi-tag
// package (-common: sh/perl/ruby/…; -git: git/gh) lights up only the tags the
// host actually has, instead of stamping all of them with the first tag's
// probe. Probes are cheap + local (command -v / env read / `gh auth status`),
// so per-tag costs nothing. A probe that rejects or exceeds its timeout
// degrades that tag to unavailable — it never crashes boot. SPEC §scheme;
// plurnk-service#181, #185.
export default class ExecutorRegistry {
    readonly #byTag: ReadonlyMap<string, RegistryEntry>;
    readonly #attributions: readonly string[]; // #249 — declared attribution tags of discovered exec packages

    constructor(byTag: ReadonlyMap<string, RegistryEntry>, attributions: readonly string[] = []) {
        this.#byTag = byTag;
        this.#attributions = attributions;
    }

    // #249 — declared attribution tags of the discovered exec packages (opaque; the engine
    // unions these across plugin families onto the generate() `attributions` wire).
    attributions(): string[] { return [...this.#attributions]; }

    static async build({ defaultRuntime = null, probeTimeoutMs = 3000, cwd, discoverFn, load = (name: string): Promise<unknown> => import(name) }: {
        defaultRuntime?: string | null;
        probeTimeoutMs?: number;
        cwd?: string;   // discovery root — the dir whose node_modules holds the exec plugins
        discoverFn?: () => Promise<{ registry: ReadonlyMap<string, { runtime: string; glyph: string; example?: string; documentation?: string; packageName: string }>; skipped?: string[] }>;
        load?: (name: string) => Promise<unknown>;
    } = {}): Promise<ExecutorRegistry> {
        const { registry: discovered, skipped = [] } = await (discoverFn ?? (() => discover({ cwd })))();

        // #229 trust gate: discover() skips untrusted third-party packages
        // (PLURNK_PLUGINS_TRUSTED_ONLY) and reports them here — note each, mirror
        // of SchemeRegistry's untrusted-scheme warning. Discovered, not loaded.
        for (const name of skipped) {
            console.warn(`exec discovery: '${name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }

        // #259 — git lockout. PLURNK_GIT_ALLOWED=0 must drop the git/gh executors ENTIRELY (not
        // just membership + telemetry): a denied host neither dispatches EXEC[git]/[gh] nor teaches
        // them (the tools sheet reads the registered set). "No git" then training on git is a break.
        const gitDenied = process.env.PLURNK_GIT_ALLOWED !== "1";
        const infos = [...discovered.values()].filter((info) => !(gitDenied && info.packageName === "@plurnk/plurnk-execs-git"));

        // Probe per-TAG: one executor instance per tag (this.runtime = the tag),
        // each probed on its own merits. import() is module-cached, so
        // re-importing a package once per tag is free.
        const probed = await Promise.all(infos.map(async (info) => {
            const mod = await load(info.packageName) as { default: new (metadata: ExecutorMetadata) => Executor };
            const executor = new mod.default({ runtime: info.runtime, glyph: info.glyph });
            const availability = await ExecutorRegistry.#probe(executor, probeTimeoutMs);
            return { info, executor, availability };
        }));

        const byTag = new Map<string, RegistryEntry>();
        for (const { info, executor, availability } of probed) {
            byTag.set(info.runtime, {
                executor,
                glyph: info.glyph,
                example: info.example ?? "",
                documentation: info.documentation ?? "",
                available: availability.available,
                detail: availability.detail,
            });
        }

        ExecutorRegistry.#assertDefaultUsable(byTag, defaultRuntime);
        // #249 — collect attribution per DISTINCT package (a multi-tag package — -common's
        // sh/perl/ruby — shares one manifest); fail-hard if any claims the reserved @plurnk/.
        const packages = new Set(infos.map((info) => info.packageName));
        const attributions = [...packages].flatMap((pkg) => PluginAttribution.read(pkg));
        return new ExecutorRegistry(byTag, attributions);
    }

    // A configured default runtime that can't run is an operator misconfig the
    // boot must surface, not hide behind a silent fallback.
    static #assertDefaultUsable(byTag: ReadonlyMap<string, RegistryEntry>, defaultRuntime: string | null): void {
        if (defaultRuntime === null) return;
        const entry = byTag.get(defaultRuntime);
        if (entry === undefined) throw new Error(`exec default runtime '${defaultRuntime}' has no installed executor`);
        if (!entry.available) {
            const why = entry.detail === undefined ? "" : `: ${entry.detail}`;
            throw new Error(`exec default runtime '${defaultRuntime}' is unavailable${why}`);
        }
    }

    // probe() may reject or hang; bound it and treat either as unavailable.
    static async #probe(executor: Executor, timeoutMs: number): Promise<RuntimeAvailability> {
        const controller = new AbortController();
        const timeout = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`probe exceeded ${timeoutMs}ms`)), timeoutMs);
            timer.unref();
            controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });
        try {
            return await Promise.race([executor.probe(), timeout]);
        } catch (error) {
            return { available: false, detail: error instanceof Error ? error.message : String(error) };
        } finally {
            controller.abort();
        }
    }

    entry(tag: string): RegistryEntry | undefined {
        return this.#byTag.get(tag);
    }

    // The actionable set offered to the model — available tags only. Unavailable
    // or unknown tags are omitted; they surface their `detail` on the 501 if the
    // model attempts one anyway.
    availableRuntimes(): readonly string[] {
        const tags: string[] = [];
        for (const [tag, entry] of this.#byTag) if (entry.available) tags.push(tag);
        return tags.toSorted((left, right) => left.localeCompare(right));
    }
}

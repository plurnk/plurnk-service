import { discover } from "@plurnk/plurnk-execs";
import type { ChannelDecl, ExecArgs, ExecResult, Effect, RuntimeAvailability, ExecInfo, ExecutorMetadata } from "@plurnk/plurnk-execs";

// The executor contract surface we consume (a BaseExecutor subclass). We bind
// to the contract, not the framework's class identity.
export interface Executor {
    readonly runtime: string;
    readonly glyph: string;
    get channels(): Readonly<Record<string, ChannelDecl>>;
    run(args: ExecArgs): Promise<ExecResult>;
    probe(): Promise<RuntimeAvailability>;
    effect(target: string | null): Effect;
}

export interface RegistryEntry {
    readonly executor: Executor;
    readonly glyph: string;
    readonly available: boolean;
    readonly detail: string | undefined;
}

// Boot-time runtime registry. Discovers installed @plurnk/plurnk-execs-*
// siblings (plurnk.kind:"exec"), loads + probes each package once, and stamps
// every runtime tag it claims with that executor + availability. One package
// can claim many tags (search → search/news/images/...), so the probe unit is
// the package, not the tag. A probe that rejects or exceeds its timeout
// degrades the executor to unavailable — it never crashes boot. SPEC §3;
// plurnk-service#181.
export default class ExecutorRegistry {
    readonly #byTag: ReadonlyMap<string, RegistryEntry>;

    constructor(byTag: ReadonlyMap<string, RegistryEntry>) {
        this.#byTag = byTag;
    }

    static async build({ defaultRuntime = null, probeTimeoutMs = 3000 }: {
        defaultRuntime?: string | null;
        probeTimeoutMs?: number;
    } = {}): Promise<ExecutorRegistry> {
        const { registry: discovered } = await discover();

        const packageNames = [...new Set([...discovered.values()].map((info) => info.packageName))];
        const probed = await Promise.all(packageNames.map(async (packageName) => {
            const seed = ExecutorRegistry.#seed(discovered, packageName);
            const mod = await import(packageName) as { default: new (metadata: ExecutorMetadata) => Executor };
            const executor = new mod.default({ runtime: seed.runtime, glyph: seed.glyph });
            const availability = await ExecutorRegistry.#probe(executor, probeTimeoutMs);
            return { packageName, executor, availability };
        }));
        const byPackage = new Map(probed.map((entry) => [entry.packageName, entry]));

        const byTag = new Map<string, RegistryEntry>();
        for (const info of discovered.values()) {
            const probedPackage = byPackage.get(info.packageName);
            if (probedPackage === undefined) throw new Error(`executor package ${info.packageName} vanished between discover and probe`);
            byTag.set(info.runtime, {
                executor: probedPackage.executor,
                glyph: info.glyph,
                available: probedPackage.availability.available,
                detail: probedPackage.availability.detail,
            });
        }

        ExecutorRegistry.#assertDefaultUsable(byTag, defaultRuntime);
        return new ExecutorRegistry(byTag);
    }

    static #seed(discovered: ReadonlyMap<string, ExecInfo>, packageName: string): ExecInfo {
        for (const info of discovered.values()) if (info.packageName === packageName) return info;
        throw new Error(`no runtime metadata for executor package ${packageName}`);
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

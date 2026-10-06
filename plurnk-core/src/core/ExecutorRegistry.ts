import { discover, RuntimeInvocation } from "@plurnk/plurnk-execs";
import type {
    RuntimeAvailability,
    ExecutorMetadata,
    RuntimeInvocationDecl,
    RuntimeSummaryDecl,
    RuntimeToolRegistry,
    Executor,
} from "@plurnk/plurnk-execs";
import Meta, {
    type PackageAttributions,
    type ExtensionAttribution,
    type ExtensionAttributionContext,
} from "@plurnk/plurnk-meta";
import { ConfigurationError, Knob } from "@plurnk/plurnk-meta";

// {§functionality-model-projection} — a Core-owned runtime whose verbs act for the invoking Worker.
// The framework's ExecArgs carries no Worker identity by design; Core, which owns execution
// identity, binds it at the operation and leaves the published workspace-wide instance untouched.
export interface WorkerBoundExecutor extends Executor {
    forWorker(workerId: number): Executor;
}

export const isWorkerBound = (executor: Executor): executor is WorkerBoundExecutor =>
    typeof (executor as Partial<WorkerBoundExecutor>).forWorker === "function";

export type RuntimeNamespaceOwner =
    | { readonly kind: "package"; readonly name: string }
    | { readonly kind: "module"; readonly name: string };

export interface RegistryEntry {
    readonly executor: Executor;
    // The claim core arbitrates against the addressable scheme namespace.
    // Installed runtimes retain their npm package; daemon modules retain their
    // module-local runtime identity. {§extension-namespace-arbitration}
    readonly namespaceOwner: RuntimeNamespaceOwner;
    readonly glyph: string;
    readonly summary: RuntimeSummaryDecl;
    readonly invocation: RuntimeInvocationDecl;
    // Supplemental reference detail for the generated tool document.
    readonly details: string;
    // {§tools-resource-materialization} — the generated-doc root for this
    // runtime; absent = the internal skills namespace.
    readonly resourcesPath?: string;
    // Expand this runtime's tool tree into the turn-0 tools survey.
    readonly expandTools?: boolean;
    readonly available: boolean;
    readonly detail: string | undefined;
    readonly configurationError?: never;
}

// A declaration can survive configuration failure without inventing an executor instance.
export type ExecutorEntry = RegistryEntry | (Omit<RegistryEntry, "executor" | "available" | "detail" | "configurationError"> & {
    readonly executor: null;
    readonly available: false;
    readonly detail: string;
    readonly configurationError: ConfigurationError;
});

export interface RuntimeRegistryRegistration {
    readonly tag: string;
    readonly entry: RegistryEntry;
}

// Boot-time runtime registry. Discovers installed @plurnk/plurnk-execs-*
// siblings (plurnk.kind:"exec") and probes each runtime TAG independently —
// one executor instance per tag (this.runtime = the tag), so a multi-tag
// package (-common: sh/perl/ruby/...) lights up only the tags the
// host actually has, instead of stamping all of them with the first tag's
// probe. Probes are cheap + local (command -v / env read / `gh auth status`),
// so per-tag costs nothing. A probe that rejects or exceeds its timeout
// degrades that tag to unavailable — it never crashes boot. {§exec-registry-resolves}
export default class ExecutorRegistry {
    readonly #byTag: Map<string, ExecutorEntry>;   // own copy — runtime registration mutates it in place
    readonly #workspaceByOwner = new Map<number, Map<string, Map<string, RegistryEntry>>>();
    readonly #packageAttributions: PackageAttributions;
    readonly #toolRegistries = new WeakMap<Executor, RuntimeToolRegistry | null>();

    constructor(byTag: ReadonlyMap<string, ExecutorEntry>, packageAttributions: PackageAttributions = new Map()) {
        for (const [tag, entry] of byTag) ExecutorRegistry.#assertDeclaration(tag, entry);
        this.#byTag = new Map(byTag);
        this.#packageAttributions = new Map(packageAttributions);
    }

    // Module runtime registration - add an executor tag after boot discovery. The boot path is
    // discover -> probe -> build; this is the setup door for a daemon module whose runtime names
    // depend on operator configuration. The caller owns availability; the SchemeRegistry face is registered
    // separately (registerRuntimeScheme), keeping the reserved/cross-family arbitration one-owned there.
    // Fail hard on a tag already registered: one name, one owner ({§extension-namespace-arbitration}).
    register(tag: string, entry: RegistryEntry): void {
        this.prepareRegistrations([{ tag, entry }])();
    }

    // Validate a complete late-registration set and return its no-fail commit.
    // The engine prepares the corresponding scheme set before invoking either
    // registry's commit, so cross-registry publication is atomic.
    prepareRegistrations(registrations: readonly RuntimeRegistryRegistration[]): () => void {
        const tags = new Set<string>();
        for (const { tag, entry } of registrations) {
            ExecutorRegistry.#assertDeclaration(tag, entry);
            if (tags.has(tag)) {
                throw new Error(`executor tag '${tag}' occurs more than once in one registration batch`);
            }
            tags.add(tag);
            this.assertCanRegister(tag, entry.namespaceOwner);
        }
        return () => {
            for (const { tag, entry } of registrations) {
                this.#byTag.set(tag, entry);
            }
        };
    }

    // One module owner replaces its complete runtime set within one workspace.
    // Validation observes the immutable base and every peer owner, while the
    // owner's own prior set is deliberately replaceable. The commit is
    // synchronous/no-fail and returns an equally no-fail rollback for the
    // composed registry/docs/database transaction. {§module-workspace-capabilities}
    prepareWorkspaceRegistrations(
        workspaceId: number,
        namespaceOwner: string,
        registrations: readonly RuntimeRegistryRegistration[],
    ): () => () => void {
        if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) {
            throw new Error("workspace runtime snapshot requires a positive workspace id");
        }
        if (namespaceOwner.length === 0) {
            throw new Error("workspace runtime snapshot requires a non-empty namespace owner");
        }
        const byOwner = this.#workspaceByOwner.get(workspaceId);
        const tags = new Set<string>();
        for (const { tag, entry } of registrations) {
            ExecutorRegistry.#assertDeclaration(tag, entry);
            if (tags.has(tag)) {
                throw new Error(`executor tag '${tag}' occurs more than once in one workspace snapshot`);
            }
            tags.add(tag);
            if (entry.namespaceOwner.kind !== "module" || entry.namespaceOwner.name !== namespaceOwner) {
                throw new Error(
                    `workspace executor '${tag}' must be owned by daemon module runtime '${namespaceOwner}'`,
                );
            }
            const base = this.#byTag.get(tag);
            if (base !== undefined) this.#throwCollision(tag, base.namespaceOwner, entry.namespaceOwner);
            for (const [peerOwner, entries] of byOwner ?? []) {
                if (peerOwner === namespaceOwner) continue;
                const peer = entries.get(tag);
                if (peer !== undefined) this.#throwCollision(tag, peer.namespaceOwner, entry.namespaceOwner);
            }
        }
        const next = new Map(registrations.map(({ tag, entry }) => [tag, entry]));
        const previous = byOwner?.get(namespaceOwner);
        return () => {
            const owners = this.#workspaceByOwner.get(workspaceId) ?? new Map<string, Map<string, RegistryEntry>>();
            if (next.size === 0) owners.delete(namespaceOwner);
            else owners.set(namespaceOwner, next);
            if (owners.size === 0) this.#workspaceByOwner.delete(workspaceId);
            else this.#workspaceByOwner.set(workspaceId, owners);
            let pending = true;
            return () => {
                if (!pending) return;
                pending = false;
                const current = this.#workspaceByOwner.get(workspaceId)
                    ?? new Map<string, Map<string, RegistryEntry>>();
                if (previous === undefined) current.delete(namespaceOwner);
                else current.set(namespaceOwner, previous);
                if (current.size === 0) this.#workspaceByOwner.delete(workspaceId);
                else this.#workspaceByOwner.set(workspaceId, current);
            };
        };
    }

    assertCanRegister(tag: string, incoming: RuntimeNamespaceOwner): void {
        const existing = this.#byTag.get(tag);
        if (existing !== undefined) this.#throwCollision(tag, existing.namespaceOwner, incoming);
        for (const byOwner of this.#workspaceByOwner.values()) {
            for (const entries of byOwner.values()) {
                const workspaceEntry = entries.get(tag);
                if (workspaceEntry !== undefined) {
                    this.#throwCollision(tag, workspaceEntry.namespaceOwner, incoming);
                }
            }
        }
    }

    #throwCollision(tag: string, existing: RuntimeNamespaceOwner, incoming: RuntimeNamespaceOwner): never {
        throw new Error(
            `executor tag '${tag}' is already registered by ${ExecutorRegistry.#describeOwner(existing)}; `
            + `${ExecutorRegistry.#describeOwner(incoming)} cannot claim it`,
        );
    }

    static #describeOwner(owner: RuntimeNamespaceOwner): string {
        return owner.kind === "package"
            ? `executor package '${owner.name}'`
            : `daemon module runtime '${owner.name}'`;
    }

    static #assertDeclaration(tag: string, entry: ExecutorEntry): void {
        if (entry.executor === null) return;
        if (typeof entry.summary !== "string" && entry.executor.toolRegistry === undefined) {
            throw new Error(
                `executor tag '${tag}' derives its summary from tools but exposes no exact tool registry`,
            );
        }
        const published = entry.executor.publishedChannel;
        if (published != null && !Object.hasOwn(entry.executor.channels, published)) {
            throw new Error(`executor tag '${tag}' publishes undeclared channel '${published}'`);
        }
    }

    // {§extension-attribution} Package-owned executor objects participate once by
    // identity even when one object is registered under several runtime tags.
    attributions(context: ExtensionAttributionContext): ExtensionAttribution {
        const packageSources = new Map<string, Set<Executor>>();
        for (const { executor, namespaceOwner } of this.#byTag.values()) {
            if (namespaceOwner.kind !== "package") continue;
            const sources = packageSources.get(namespaceOwner.name) ?? new Set<Executor>();
            if (executor !== null) sources.add(executor);
            packageSources.set(namespaceOwner.name, sources);
        }
        const lists: ExtensionAttribution[] = [];
        for (const [packageName, sources] of packageSources) {
            const declared = this.#packageAttributions.get(packageName);
            if (declared !== undefined) lists.push(declared);
            for (const source of sources) {
                lists.push(Meta.runtimeAttribution(source, context, packageName));
            }
        }
        return Meta.composeAttributions(...lists);
    }

    static async build({ probeTimeoutMs, cwd, discoverFn, load = (name: string): Promise<unknown> => import(name) }: {
        probeTimeoutMs?: number;
        cwd?: string;   // discovery root — the dir whose node_modules holds the exec extensions
        discoverFn?: () => Promise<{
            registry: ReadonlyMap<string, { runtime: string; glyph: string; summary: RuntimeSummaryDecl; invocation: RuntimeInvocationDecl; details: string; resourcesPath?: string; expandTools?: boolean; packageName: string }>;
            packageAttributions?: PackageAttributions;
            skipped?: string[];
        }>;
        load?: (name: string) => Promise<unknown>;
    } = {}): Promise<ExecutorRegistry> {
        const {
            registry: discovered,
            packageAttributions = new Map(),
            skipped = [],
        } = await (discoverFn ?? (() => discover({ cwd })))();

        // {§extension-trust-boundary} discover() skips untrusted third-party packages
        // (PLURNK_EXTENSIONS_TRUSTED_ONLY) and reports them here — note each, mirror
        // of SchemeRegistry's untrusted-scheme warning. Discovered, not loaded.
        for (const name of skipped) {
            console.warn(`exec discovery: '${name}' is discovered but untrusted (PLURNK_EXTENSIONS_TRUSTED_ONLY); not registered`);
        }

        const infos = [...discovered.values()];

        // Probe per-TAG: one executor instance per tag (this.runtime = the tag),
        // each probed on its own merits. import() is module-cached, so
        // re-importing a package once per tag is free.
        const probed = await Promise.all(infos.map(async (info): Promise<readonly [string, ExecutorEntry]> => {
            const declaration = {
                namespaceOwner: { kind: "package" as const, name: info.packageName },
                glyph: info.glyph,
                summary: info.summary,
                invocation: info.invocation,
                details: info.details,
                ...(info.resourcesPath === undefined ? {} : { resourcesPath: info.resourcesPath }),
                ...(info.expandTools === undefined ? {} : { expandTools: info.expandTools }),
            };
            try {
                const timeoutMs = probeTimeoutMs ?? ExecutorRegistry.validateConfiguration();
                const mod = await load(info.packageName) as { default: new (metadata: ExecutorMetadata) => Executor };
                const executor = new mod.default({ runtime: info.runtime, glyph: info.glyph });
                const availability = await ExecutorRegistry.#probe(executor, timeoutMs);
                return [info.runtime, { ...declaration, executor, available: availability.available, detail: availability.detail }];
            } catch (cause) {
                if (!(cause instanceof ConfigurationError)) throw cause;
                return [info.runtime, { ...declaration, executor: null, available: false, detail: cause.message, configurationError: cause }];
            }
        }));
        return new ExecutorRegistry(new Map(probed), packageAttributions);
    }

    static validateConfiguration(): number {
        return Knob.integer("PLURNK_SERVICE_EXEC_PROBE_TIMEOUT_MS", 1);
    }

    configurationErrors(): ReadonlyArray<{ runtime: string; error: ConfigurationError }> {
        return [...this.#byTag].flatMap(([runtime, entry]) => entry.configurationError === undefined
            ? [] : [{ runtime, error: entry.configurationError }]);
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
            // Hand the probe our abort signal — the finally reaps its child on resolve OR timeout,
            // so a slow --version write cannot EPIPE after the host tears down ({§executor-probe}).
            return await Promise.race([executor.probe(controller.signal), timeout]);
        } catch (error) {
            if (error instanceof ConfigurationError) throw error;
            return { available: false, detail: error instanceof Error ? error.message : String(error) };
        } finally {
            controller.abort();
        }
    }

    entry(tag: string, workspaceId?: number): ExecutorEntry | undefined {
        if (workspaceId !== undefined) {
            for (const entries of this.#workspaceByOwner.get(workspaceId)?.values() ?? []) {
                const entry = entries.get(tag);
                if (entry !== undefined) return entry;
            }
        }
        return this.#byTag.get(tag);
    }

    // A family runtime's exact tools, summaries, and invocation contracts
    // cross the extension boundary as one validated snapshot. Absence means the
    // runtime's static invocation declaration is authoritative.
    toolRegistry(tag: string, workspaceId?: number): RuntimeToolRegistry | null {
        const entry = this.entry(tag, workspaceId);
        if (entry === undefined || entry.executor === null || entry.executor.toolRegistry === undefined) return null;
        const cached = this.#toolRegistries.get(entry.executor);
        if (cached !== undefined || this.#toolRegistries.has(entry.executor)) return cached ?? null;
        const registry = RuntimeInvocation.assertToolRegistry(
            entry.executor.toolRegistry(),
            entry.namespaceOwner.name,
            tag,
        );
        this.#toolRegistries.set(entry.executor, registry);
        return registry;
    }

    // The actionable set offered to the model — available tags only. Unavailable
    // or unknown tags are omitted; they surface their `detail` on the 501 if the
    // model attempts one anyway.
    // {§bare-option-object} — the available runtimes whose declared body is JSON.
    jsonBodyRuntimes(workspaceId?: number): readonly string[] {
        return this.availableRuntimes(workspaceId).filter((tag) => this.entry(tag, workspaceId)?.invocation.body.mimetype === "application/json");
    }

    availableRuntimes(workspaceId?: number): readonly string[] {
        const tags = new Set<string>();
        for (const [tag, entry] of this.#byTag) if (entry.available) tags.add(tag);
        if (workspaceId !== undefined) {
            for (const entries of this.#workspaceByOwner.get(workspaceId)?.values() ?? []) {
                for (const [tag, entry] of entries) if (entry.available) tags.add(tag);
            }
        }
        return [...tags].toSorted((left, right) => left.localeCompare(right));
    }
}

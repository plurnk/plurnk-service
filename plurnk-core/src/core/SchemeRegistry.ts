import Log from "../schemes/Log.ts";
import Exec, { type WebFetch } from "../schemes/Exec.ts";
import Prompt from "../schemes/Prompt.ts";
import Skill from "../schemes/Skill.ts";
import File from "../schemes/File.ts";
import Worker from "../schemes/Worker.ts";
import ResolveForLoop from "./resolveForLoop.ts";
import type { LoopFlags } from "./types.ts";
import {
    Manifest,
    PacketSections,
    SchemeDiscovery,
    type PacketSectionDraft,
    type PacketSectionTransformer,
    type SchemeEntryInheritance,
    type SchemeHandler,
} from "@plurnk/plurnk-schemes";
import type { SchemeManifest } from "./scheme-types.ts";
import ExecOutputScheme from "../schemes/ExecOutputScheme.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { Executor, RuntimeNamespaceOwner } from "./ExecutorRegistry.ts";
import { docsExcludeSet } from "./teaching.ts";
import type { CoreSchemeAdapter, CoreSchemeServices } from "./CoreSchemeServices.ts";
import type { RuntimeSchemeFacet } from "../server/DaemonModule.ts";
import Meta, {
    TEACHING_CORPUS,
    type PluginAttribution,
    type PluginAttributionContext,
} from "@plurnk/plurnk-meta";
import { readTeachingSource, type ReadTeaching } from "./teaching-corpus.ts";
import { routedSchemeName } from "./plurnk-uri.ts";

interface NamespaceClaim {
    readonly key: string;
    readonly label: string;
    readonly reserved: boolean;
}

interface RuntimeSchemeRegistration {
    readonly tag: string;
    readonly executor: Executor;
    readonly owner: RuntimeNamespaceOwner;
    readonly facet?: RuntimeSchemeFacet;
}

interface WorkerSchemeSnapshot {
    readonly handlers: ReadonlyMap<string, object>;
    readonly claims: ReadonlyMap<string, NamespaceClaim>;
}

export default class SchemeRegistry {
    // Handler store. Dispatcher supplies one context implementation to bundled
    // and discovered schemes alike.
    #handlers = new Map<string, object>();
    #workerByOwner = new Map<number, Map<string, WorkerSchemeSnapshot>>();
    #readiness = new Map<object, Promise<void>>();
    #closures = new Map<object, Promise<void>>();
    #coreServices: CoreSchemeServices | undefined;
    #packageAttributions = new Map<string, PluginAttribution>();
    #packageAttributionSources = new Map<string, Set<object>>();
    // {§exec} — runtime-tag schemes (sh/node/…) that ALIAS the exec handler for output-entry
    // addressing (sh:///l/t/s). Routable via get(), but NOT separately taught or doc-materialized
    // (exec is taught once); else the catalog + docs bloat by one redundant line/entry per tag.
    #runtimeSchemes = new Set<string>();
    // One ownership ledger for built-ins, installed schemes, runtime output
    // faces, and programmatic schemes. {§plugin-namespace-arbitration}
    #claims = new Map<string, NamespaceClaim>();
    #readTeaching: ReadTeaching;
    #schemeDocs: Promise<ReadonlyMap<string, string>> | undefined;


    // `fetchWeb` ({§exec-entry-sink}) is forwarded to the exec handler's content:null sink; default
    // = schemes-http's checked WebFetcher, injectable so tests substitute automatic network acquisition.
    constructor(opts?: { fetchWeb?: WebFetch; readTeaching?: ReadTeaching }) {
        this.#readTeaching = opts?.readTeaching ?? readTeachingSource;
        this.#registerBuiltIn("log", new Log());
        // {§scheme} — "exec" is internal machinery, not an addressable scheme: the EXEC op routes here
        // and the spawn-abort/idle state lives here, but the model addresses output via the tag
        // schemes (sh://, jq://) and process-KILLs the tag coordinate. The knowledgebase
        // is worker:// (commons/~/name/plurnk), and task frames are prompt://.
        this.#registerBuiltIn("exec", new Exec(opts?.fetchWeb));
        this.#registerBuiltIn("prompt", new Prompt());
        this.#registerBuiltIn("skill", new Skill());
        this.#registerBuiltIn("file", new File());
        this.#registerBuiltIn("worker", new Worker());
    }

    register(name: string, handler: object): void {
        const claim = SchemeRegistry.#programmaticClaim(name);
        this.#registerClaimed(name, handler, claim);
    }

    #registerBuiltIn(name: string, handler: object): void {
        const claim: NamespaceClaim = {
            key: "core:@plurnk/plurnk-service",
            label: "core package '@plurnk/plurnk-service'",
            reserved: true,
        };
        this.#registerClaimed(name, handler, claim);
    }

    #registerClaimed(name: string, handler: object, claim: NamespaceClaim, sameOwnerRescan = false): boolean {
        if (this.#assertClaim(name, claim, sameOwnerRescan) === "same") return false;
        Manifest.of(handler, name);
        const bindCore = (handler as Partial<CoreSchemeAdapter>).bindCore;
        if (this.#coreServices !== undefined && typeof bindCore === "function") bindCore.call(handler, this.#coreServices);
        this.#handlers.set(name, handler);
        this.#claims.set(name, claim);
        return true;
    }

    #assertClaim(name: string, incoming: NamespaceClaim, sameOwnerRescan: boolean): "new" | "same" {
        const existing = this.#claims.get(name);
        if (existing === undefined) return "new";
        if (sameOwnerRescan && existing.key === incoming.key) return "same";
        if (existing.reserved) {
            throw new Error(`scheme name '${name}' is reserved by ${existing.label}; ${incoming.label} cannot claim it`);
        }
        throw new Error(`scheme name '${name}' is claimed by both ${existing.label} and ${incoming.label}`);
    }

    static #programmaticClaim(name: string): NamespaceClaim {
        return {
            key: `programmatic-scheme:${name}`,
            label: `programmatic scheme '${name}'`,
            reserved: false,
        };
    }

    static #externalSchemeClaim(packageName: string): NamespaceClaim {
        return {
            key: `scheme-package:${packageName}`,
            label: `scheme package '${packageName}'`,
            reserved: false,
        };
    }

    static #runtimeClaim(owner: RuntimeNamespaceOwner): NamespaceClaim {
        return owner.kind === "package"
            ? {
                key: `executor-package:${owner.name}`,
                label: `executor package '${owner.name}'`,
                reserved: false,
            }
            : {
                key: `module-runtime:${owner.name}`,
                label: `daemon module runtime '${owner.name}'`,
                reserved: false,
            };
    }

    bindCore(services: CoreSchemeServices): void {
        this.#coreServices = services;
        for (const handler of this.#allHandlers()) {
            const bindCore = (handler as Partial<CoreSchemeAdapter>).bindCore;
            if (typeof bindCore === "function") bindCore.call(handler, services);
        }
    }

    // {§exec} — exec output entries address by their runtime tag as authority
    // (sh:///l/t/s). Register each discovered executor as its OWN per-tag scheme face
    // (ExecOutputScheme): READ/FIND tag-scoped via the executor's manifest, process-KILL
    // delegated to the shared Exec handler. Minted from the boot ExecutorRegistry; in-tree
    // names are reserved (a tag shadowing a built-in fails hard, never overrides it).
    registerRuntimeSchemes(executors: ExecutorRegistry): void {
        for (const tag of executors.availableRuntimes()) {
            const entry = executors.entry(tag);
            if (entry === undefined) continue;
            this.registerRuntimeScheme(tag, entry.executor, entry.namespaceOwner, undefined, true);
        }
    }

    // Register one executor tag's scheme face (the boot loop above or daemon-module setup).
    // Cross-family arbitration lives here so boot and module paths share one
    // namespace. {§plugin-namespace-arbitration}
    registerRuntimeScheme(
        tag: string,
        executor: Executor,
        owner: RuntimeNamespaceOwner,
        facet?: RuntimeSchemeFacet,
        sameOwnerRescan = false,
    ): void {
        this.prepareRuntimeSchemes([{
            tag,
            executor,
            owner,
            facet,
        }], sameOwnerRescan)();
    }

    // Validate and construct a complete set before exposing any scheme name.
    // Returned commit mutates maps and sets only; all fallible manifest and
    // core-binding work has already completed.
    prepareRuntimeSchemes(
        registrations: readonly RuntimeSchemeRegistration[],
        sameOwnerRescan = false,
    ): () => void {
        const exec = this.#handlers.get("exec");
        if (!(exec instanceof Exec)) throw new Error("registerRuntimeScheme: the exec handler is not registered");
        const tags = new Set<string>();
        const prepared: Array<{
            tag: string;
            handler: ExecOutputScheme;
            claim: NamespaceClaim;
        }> = [];
        for (const { tag, executor, owner, facet } of registrations) {
            if (tags.has(tag)) {
                throw new Error(`scheme name '${tag}' occurs more than once in one registration batch`);
            }
            tags.add(tag);
            const claim = SchemeRegistry.#runtimeClaim(owner);
            if (this.#assertClaim(tag, claim, sameOwnerRescan) === "same") continue;
            const handler = new ExecOutputScheme(executor, exec, facet);
            Manifest.of(handler, tag);
            const bindCore = (handler as Partial<CoreSchemeAdapter>).bindCore;
            if (this.#coreServices !== undefined && typeof bindCore === "function") {
                bindCore.call(handler, this.#coreServices);
            }
            prepared.push({ tag, handler, claim });
        }
        return () => {
            for (const { tag, handler, claim } of prepared) {
                this.#handlers.set(tag, handler);
                this.#claims.set(tag, claim);
                this.#runtimeSchemes.add(tag);
            }
        };
    }

    async prepareWorkerRuntimeSchemes(
        workerId: number,
        namespaceOwner: string,
        registrations: readonly RuntimeSchemeRegistration[],
    ): Promise<() => () => void> {
        if (!Number.isSafeInteger(workerId) || workerId < 1) {
            throw new Error("worker scheme snapshot requires a positive worker id");
        }
        if (namespaceOwner.length === 0) {
            throw new Error("worker scheme snapshot requires a non-empty namespace owner");
        }
        const exec = this.#handlers.get("exec");
        if (!(exec instanceof Exec)) throw new Error("worker runtime scheme: the exec handler is not registered");
        const tags = new Set<string>();
        const handlers = new Map<string, object>();
        const claims = new Map<string, NamespaceClaim>();
        const workerOwners = this.#workerByOwner.get(workerId);
        for (const { tag, executor, owner, facet } of registrations) {
            if (tags.has(tag)) {
                throw new Error(`scheme name '${tag}' occurs more than once in one worker snapshot`);
            }
            tags.add(tag);
            if (owner.kind !== "module" || owner.name !== namespaceOwner) {
                throw new Error(`worker scheme '${tag}' must be owned by daemon module runtime '${namespaceOwner}'`);
            }
            const incoming = SchemeRegistry.#runtimeClaim(owner);
            const base = this.#claims.get(tag);
            if (base !== undefined) this.#throwClaimCollision(tag, base, incoming);
            for (const [peerOwner, snapshot] of workerOwners ?? []) {
                if (peerOwner === namespaceOwner) continue;
                const peer = snapshot.claims.get(tag);
                if (peer !== undefined) this.#throwClaimCollision(tag, peer, incoming);
            }
            const handler = new ExecOutputScheme(executor, exec, facet);
            Manifest.of(handler, tag);
            const bindCore = (handler as Partial<CoreSchemeAdapter>).bindCore;
            if (this.#coreServices !== undefined && typeof bindCore === "function") {
                bindCore.call(handler, this.#coreServices);
            }
            await this.#readyHandler(handler);
            handlers.set(tag, handler);
            claims.set(tag, incoming);
        }
        const next: WorkerSchemeSnapshot = { handlers, claims };
        const previous = workerOwners?.get(namespaceOwner);
        return () => {
            const owners = this.#workerByOwner.get(workerId)
                ?? new Map<string, WorkerSchemeSnapshot>();
            if (handlers.size === 0) owners.delete(namespaceOwner);
            else owners.set(namespaceOwner, next);
            if (owners.size === 0) this.#workerByOwner.delete(workerId);
            else this.#workerByOwner.set(workerId, owners);
            let pending = true;
            return () => {
                if (!pending) return;
                pending = false;
                const current = this.#workerByOwner.get(workerId)
                    ?? new Map<string, WorkerSchemeSnapshot>();
                if (previous === undefined) current.delete(namespaceOwner);
                else current.set(namespaceOwner, previous);
                if (current.size === 0) this.#workerByOwner.delete(workerId);
                else this.#workerByOwner.set(workerId, current);
            };
        };
    }

    #throwClaimCollision(name: string, existing: NamespaceClaim, incoming: NamespaceClaim): never {
        if (existing.reserved) {
            throw new Error(`scheme name '${name}' is reserved by ${existing.label}; ${incoming.label} cannot claim it`);
        }
        throw new Error(`scheme name '${name}' is claimed by both ${existing.label} and ${incoming.label}`);
    }

    get(name: string, workerId?: number): object | undefined {
        if (workerId !== undefined) {
            for (const snapshot of this.#workerByOwner.get(workerId)?.values() ?? []) {
                const handler = snapshot.handlers.get(name);
                if (handler !== undefined) return handler;
            }
        }
        return this.#handlers.get(name);
    }

    has(name: string, workerId?: number): boolean { return this.get(name, workerId) !== undefined; }

    manifestFor(name: string, workerId?: number): SchemeManifest | undefined {
        const handler = this.get(name, workerId);
        return handler === undefined ? undefined : Manifest.of(handler, name);
    }

    entryInheritanceForStoredScheme(scheme: string, workerId: number): SchemeEntryInheritance {
        const manifest = this.manifestFor(routedSchemeName(scheme), workerId);
        return manifest?.category === "data" ? manifest.inherit : "none";
    }

    list(workerId?: number): string[] {
        return [...this.#effectiveHandlers(workerId).keys()].toSorted();
    }

    // {§handler-lifecycle} — discovery proves importability; one successful
    // ready() per object identity proves advertised resources are usable.
    async ready(): Promise<void> {
        for (const handler of this.#allHandlers()) await this.#readyHandler(handler);
    }

    #readyHandler(handler: object): Promise<void> {
        let readiness = this.#readiness.get(handler);
        if (readiness === undefined) {
            readiness = Promise.resolve().then(async () => {
                const ready = (handler as Partial<SchemeHandler>).ready;
                if (ready !== undefined) await ready.call(handler);
            });
            this.#readiness.set(handler, readiness);
        }
        return readiness;
    }

    // {§handler-lifecycle} — aliases may share a handler. Attempt and await every
    // unique close once, then surface all failures together.
    async close(): Promise<void> {
        const closures = [...this.#allHandlers()].map((handler) => {
            let closure = this.#closures.get(handler);
            if (closure === undefined) {
                closure = Promise.resolve().then(async () => {
                    const close = (handler as Partial<SchemeHandler>).close;
                    if (close !== undefined) await close.call(handler);
                });
                this.#closures.set(handler, closure);
            }
            return closure;
        });
        const results = await Promise.allSettled(closures);
        const errors = results
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason]);
        if (errors.length > 0) throw new AggregateError(errors, "scheme handler shutdown failed");
    }

    // A scheme's default channel (manifest.defaultChannel) — the channel a fragment-less
    // address targets. Drives the manifest's address-keyed channels (note 4).
    defaultChannelFor(scheme: string, workerId?: number): string {
        return this.manifestFor(scheme, workerId)?.defaultChannel ?? "body";
    }

    // {§schemes-directory} The `schemes` packet section follows privileged policy.
    // Language teaching covers grammar and dialects, not
    // the installed scheme set, so the service advertises what resources exist at
    // packet-time. Each handler that ships
    // `manifest.example` contributes concise canonical operation examples, plus a
    // pull doc when it ships `manifest.documentation` (materialized at
    // worker://~/skills/plurnk/<name>.md by LoopDocs, READ on demand). The verbose semantics live
    // in that pull doc, not here: terse pushes, depth pulls. These are complete
    // operation examples. Insertion order; a scheme with no example
    // (provisional, e.g. skill) is omitted. The doc's curation weight rides its manifest entry.
    teach(workerId?: number): string {
        const examples: string[] = [];
        const excluded = docsExcludeSet();
        for (const name of this.#effectiveHandlers(workerId).keys()) {
            if (this.#isRuntimeScheme(name, workerId)) continue; // {§exec} — runtime aliases route, but exec is taught once
            if (excluded.has(name)) continue; // {§schemes-directory} — exclude drops the example and doc
            const manifest = this.manifestFor(name, workerId);
            const example = manifest?.example;
            if (typeof example !== "string" || example.length === 0) continue;
            examples.push(example); // {§packet-operation-fences} — bare ops, fenced rather than bulleted
        }
        // Scheme examples use the shared model-facing operation fence. {§packet-operation-fences}
        return examples.length > 0 ? `\`\`\`plurnk\n${examples.join("\n\n")}\n\`\`\`` : "";
    }

    async #requiredSchemeDocs(): Promise<ReadonlyMap<string, string>> {
        this.#schemeDocs ??= Promise.all(
            Object.entries(TEACHING_CORPUS.schemeDocs).map(async ([name, source]) =>
                [name, await this.#readTeaching(source)] as const),
        ).then((entries) => new Map(entries));
        return this.#schemeDocs;
    }

    // {§teaching-corpus} — exact meta-owned sources are required; manifest-owned
    // documentation is the deliberately optional fallback for every other scheme.
    async docs(workerId?: number): Promise<Array<{ name: string; content: string }>> {
        const schemeDocs = await this.#requiredSchemeDocs();
        const out: Array<{ name: string; content: string }> = [];
        const excluded = docsExcludeSet();
        for (const name of this.#effectiveHandlers(workerId).keys()) {
            if (this.#isRuntimeScheme(name, workerId)) continue; // {§exec} — runtime aliases share exec's doc, not their own
            if (excluded.has(name)) continue; // {§schemes-directory} — exclude drops the doc
            const inline = this.manifestFor(name, workerId)?.documentation;
            const content = schemeDocs.get(name) ?? (typeof inline === "string" && inline.length > 0 ? inline : undefined);
            if (content !== undefined && content.length > 0) out.push({ name, content });
        }
        return out;
    }


    // {§scheme-packet-transform} {§packet-plugin-transform}.
    async transformSections(sections: PacketSectionDraft[], workerId?: number): Promise<PacketSectionDraft[]> {
        let current = PacketSections.assertDrafts(sections, "core packet defaults");
        for (const [name, handler] of this.#effectiveHandlers(workerId)) {
            const transform = (handler as Partial<PacketSectionTransformer>).transformSections;
            if (typeof transform !== "function") continue;
            current = PacketSections.assertDrafts(
                await transform.call(handler, current),
                `scheme '${name}' transformSections result`,
            );
        }
        return current;
    }

    // Discover external scheme siblings — delegated to the framework's SchemeDiscovery
    // (schemes 0.9+): the scope-agnostic node_modules scan for plurnk.kind:"scheme" +
    // plurnk.name AND the PLURNK_PLUGINS_TRUSTED_ONLY trust gate (untrusted → `skipped`,
    // never crashed) both live there now, single-sourced across the plugin families
    // (the "delegate upstream" rule — execs/mimetypes/providers already ship discover()).
    // The service keeps only consumer policy: in-tree precedence (a name a built-in owns
    // is left as-is) and importing + registering the trusted descriptors.
    async discoverExternal(cwd: string = process.cwd()): Promise<void> {
        const { schemes, packageAttributions, skipped } = await SchemeDiscovery.discover({ cwd });
        for (const name of skipped) {
            console.warn(`scheme discovery: '${name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }
        for (const { name, packageName, exportName } of schemes) {
            const claim = SchemeRegistry.#externalSchemeClaim(packageName);
            if (this.#assertClaim(name, claim, true) === "same") continue;
            // {§plugin-discovery} — a multi-scheme package names each scheme's export (`plurnk.schemes[].export`);
            // absent = the classic single default export. A declared export that isn't a constructor
            // fails the boot hard — a manifest naming a missing class is a misdeclaration, not a skip.
            const mod = await import(packageName) as Record<string, new () => SchemeHandler>;
            const Handler = mod[exportName ?? "default"];
            if (typeof Handler !== "function") throw new Error(`external scheme '${name}' (${packageName}): export '${exportName ?? "default"}' is not a constructor`);
            const handler = new Handler();
            this.#registerClaimed(name, handler, claim, true);
            const sources = this.#packageAttributionSources.get(packageName) ?? new Set<object>();
            sources.add(handler);
            this.#packageAttributionSources.set(packageName, sources);
            const attribution = packageAttributions.get(packageName);
            if (attribution !== undefined) this.#packageAttributions.set(packageName, attribution);
        }
    }

    // {§plugin-attribution} — static declarations are always-on; each admitted
    // external handler may add or omit opaque tags for this exact attempt.
    attributions(context: PluginAttributionContext): PluginAttribution {
        const lists: PluginAttribution[] = [...this.#packageAttributions.values()];
        for (const [packageName, sources] of this.#packageAttributionSources) {
            for (const source of sources) {
                lists.push(Meta.runtimeAttribution(source, context, packageName));
            }
        }
        return Meta.composeAttributions(...lists);
    }

    // Active set under the given loop flags (SPEC {§engine-rails}). Delegates to
    // the in-tree ResolveForLoop utility.
    resolveForLoop(flags: LoopFlags, workerId?: number): Set<string> {
        return ResolveForLoop.resolveForLoop(this.#effectiveHandlers(workerId), flags);
    }

    #effectiveHandlers(workerId?: number): Map<string, object> {
        const handlers = new Map(this.#handlers);
        if (workerId !== undefined) {
            for (const snapshot of this.#workerByOwner.get(workerId)?.values() ?? []) {
                for (const [name, handler] of snapshot.handlers) handlers.set(name, handler);
            }
        }
        return handlers;
    }

    #isRuntimeScheme(name: string, workerId?: number): boolean {
        if (this.#runtimeSchemes.has(name)) return true;
        if (workerId === undefined) return false;
        for (const snapshot of this.#workerByOwner.get(workerId)?.values() ?? []) {
            if (snapshot.handlers.has(name)) return true;
        }
        return false;
    }

    #allHandlers(): Set<object> {
        const handlers = new Set(this.#handlers.values());
        for (const owners of this.#workerByOwner.values()) {
            for (const snapshot of owners.values()) {
                for (const handler of snapshot.handlers.values()) handlers.add(handler);
            }
        }
        return handlers;
    }
}

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

interface NamespaceClaim {
    readonly key: string;
    readonly label: string;
    readonly reserved: boolean;
}

export default class SchemeRegistry {
    // Handler store. Dispatcher supplies one context implementation to bundled
    // and discovered schemes alike.
    #handlers = new Map<string, object>();
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
    #questionsDoc: Promise<string> | undefined;

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
        for (const handler of new Set(this.#handlers.values())) {
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
        const exec = this.#handlers.get("exec");
        if (!(exec instanceof Exec)) throw new Error("registerRuntimeScheme: the exec handler is not registered");
        const claim = SchemeRegistry.#runtimeClaim(owner);
        if (this.#assertClaim(tag, claim, sameOwnerRescan) === "same") return;
        this.#registerClaimed(tag, new ExecOutputScheme(executor, exec, facet), claim, sameOwnerRescan);
        this.#runtimeSchemes.add(tag);
    }

    assertRuntimeClaim(tag: string, owner: RuntimeNamespaceOwner): void {
        this.#assertClaim(tag, SchemeRegistry.#runtimeClaim(owner), false);
    }

    get(name: string): object | undefined { return this.#handlers.get(name); }

    has(name: string): boolean { return this.#handlers.has(name); }

    manifestFor(name: string): SchemeManifest | undefined {
        const handler = this.#handlers.get(name);
        return handler === undefined ? undefined : Manifest.of(handler, name);
    }

    list(): string[] { return [...this.#handlers.keys()].toSorted(); }

    // {§handler-lifecycle} — discovery proves importability; one successful
    // ready() per object identity proves advertised resources are usable.
    async ready(): Promise<void> {
        const handlers = new Set(this.#handlers.values());
        for (const handler of handlers) {
            let readiness = this.#readiness.get(handler);
            if (readiness === undefined) {
                readiness = Promise.resolve().then(async () => {
                    const ready = (handler as Partial<SchemeHandler>).ready;
                    if (ready !== undefined) await ready.call(handler);
                });
                this.#readiness.set(handler, readiness);
            }
            await readiness;
        }
    }

    // {§handler-lifecycle} — aliases may share a handler. Attempt and await every
    // unique close once, then surface all failures together.
    async close(): Promise<void> {
        const closures = [...new Set(this.#handlers.values())].map((handler) => {
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
    defaultChannelFor(scheme: string): string {
        return this.manifestFor(scheme)?.defaultChannel ?? "body";
    }

    // {§schemes-directory} The `schemes` packet section sits below tools. Language
    // teaching covers grammar and dialects, not the installed scheme set, so the
    // service advertises what resources exist at packet-time. Each handler that ships
    // `manifest.example` contributes concise canonical operation examples, plus a
    // pull doc when it ships `manifest.documentation` (materialized at
    // worker://plurnk/docs/<name>.md by LoopDocs, READ on demand). The verbose semantics live
    // in that pull doc, not here: terse pushes, depth pulls. Unlike the executor
    // contract table, these are complete operation examples. Insertion order; a scheme with no example
    // (provisional, e.g. skill) is omitted. The doc's token weight rides its manifest entry.
    teach(): string {
        const examples: string[] = [];
        const excluded = docsExcludeSet();
        for (const [name, handler] of this.#handlers) {
            if (this.#runtimeSchemes.has(name)) continue; // {§exec} — runtime aliases route, but exec is taught once
            if (excluded.has(name)) continue; // {§schemes-directory} — exclude drops the example and doc
            const manifest = this.manifestFor(name);
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
    async docs(): Promise<Array<{ name: string; content: string }>> {
        const schemeDocs = await this.#requiredSchemeDocs();
        const out: Array<{ name: string; content: string }> = [];
        const excluded = docsExcludeSet();
        for (const [name, handler] of this.#handlers) {
            if (this.#runtimeSchemes.has(name)) continue; // {§exec} — runtime aliases share exec's doc, not their own
            if (excluded.has(name)) continue; // {§schemes-directory} — exclude drops the doc
            const inline = this.manifestFor(name)?.documentation;
            const content = schemeDocs.get(name) ?? (typeof inline === "string" && inline.length > 0 ? inline : undefined);
            if (content !== undefined && content.length > 0) out.push({ name, content });
        }
        return out;
    }

    questionsDoc(): Promise<string> {
        this.#questionsDoc ??= this.#readTeaching(TEACHING_CORPUS.questions);
        return this.#questionsDoc;
    }

    // {§scheme-packet-transform} {§packet-plugin-transform}.
    async transformSections(sections: PacketSectionDraft[]): Promise<PacketSectionDraft[]> {
        let current = PacketSections.assertDrafts(sections, "core packet defaults");
        for (const [name, handler] of this.#handlers) {
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
    resolveForLoop(flags: LoopFlags): Set<string> {
        return ResolveForLoop.resolveForLoop(this.#handlers, flags);
    }
}

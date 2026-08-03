import Log from "../schemes/Log.ts";
import Exec, { type WebFetch } from "../schemes/Exec.ts";
import Prompt from "../schemes/Prompt.ts";
import Skill from "../schemes/Skill.ts";
import File from "../schemes/File.ts";
import Worker from "../schemes/Worker.ts";
import ResolveForLoop from "./resolveForLoop.ts";
import type { LoopFlags } from "./types.ts";
import { Manifest, SchemeDiscovery, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type { PacketSection } from "./packet-wire.ts";
import type { PacketSectionTransformer, SchemeManifest } from "./scheme-types.ts";
import PluginAttribution from "./plugin-attribution.ts";
import ExecOutputScheme from "../schemes/ExecOutputScheme.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type { Executor } from "./ExecutorRegistry.ts";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Paths from "../Paths.ts";
import { docsExcludeSet } from "./teaching.ts";
import type { CoreSchemeAdapter, CoreSchemeServices } from "./CoreSchemeServices.ts";
import type { RuntimeSchemeFacet } from "../server/DaemonModule.ts";

// Core-owned scheme depth may live in the metaproject teaching corpus
// ({§teaching-corpus}, Paths.schemeDocs), loaded once at module evaluation. docs() prefers that
// corpus over a manifest's inline `documentation`; plugin schemes and core
// schemes without a corpus entry use the manifest field. Absent dir → empty map.
const SCHEME_DOCS: ReadonlyMap<string, string> = await (async () => {
    try {
        const files = (await readdir(Paths.schemeDocs)).filter((f) => f.endsWith(".md"));
        const loaded = await Promise.all(files.map(async (f) => [f.slice(0, -3), await readFile(resolve(Paths.schemeDocs, f), "utf8")] as const));
        return new Map(loaded);
    } catch { return new Map(); }
})();

export default class SchemeRegistry {
    // Handler store. Dispatcher supplies one context implementation to bundled
    // and discovered schemes alike.
    #handlers = new Map<string, object>();
    #readiness = new Map<object, Promise<void>>();
    #closures = new Map<object, Promise<void>>();
    #coreServices: CoreSchemeServices | undefined;
    #attributions: string[] = []; // #249 — declared attribution tags of discovered external schemes
    // {§exec} — runtime-tag schemes (sh/node/…) that ALIAS the exec handler for output-entry
    // addressing (sh:///l/t/s). Routable via get(), but NOT separately taught or doc-materialized
    // (exec is taught once); else the catalog + docs bloat by one redundant line/entry per tag.
    #runtimeSchemes = new Set<string>();
    // #240 — built-in scheme names (captured at construction), reserved namespace-wide.
    #reserved: ReadonlySet<string> = new Set();

    // `fetchWeb` ({§exec-entry-sink} / #455) is forwarded to the exec handler's content:null sink; default
    // = schemes-http's guarded WebFetcher, injectable so tests substitute the network the guard would block.
    constructor(opts?: { fetchWeb?: WebFetch }) {
        this.register("log",    new Log());
        // #527 — "exec" is INTERNAL machinery, not an addressable scheme: the EXEC op routes here
        // and the spawn-abort/idle state lives here, but the model addresses output via the tag
        // schemes (sh://, jq://) and process-KILLs the tag coordinate. The knowledgebase
        // is worker:// (commons/~/name/plurnk), and task frames are prompt://.
        this.register("exec",   new Exec(opts?.fetchWeb));
        this.register("prompt", new Prompt());
        this.register("skill",  new Skill());
        this.register("file",   new File());
        this.register("worker", new Worker());
        // #240 — the in-tree names are RESERVED across the whole scheme namespace: a
        // discovered executor or external scheme claiming one fails the boot hard, never
        // silently shadowed. (exec stays poisoned-but-registered — the EXEC op + kill state.)
        this.#reserved = new Set(this.#handlers.keys());
    }

    register(name: string, handler: object): void {
        if (this.#handlers.has(name)) throw new Error(`scheme '${name}' is already registered`);
        Manifest.of(handler, name);
        const bindCore = (handler as Partial<CoreSchemeAdapter>).bindCore;
        if (this.#coreServices !== undefined && typeof bindCore === "function") bindCore.call(handler, this.#coreServices);
        this.#handlers.set(name, handler);
    }

    bindCore(services: CoreSchemeServices): void {
        this.#coreServices = services;
        for (const handler of new Set(this.#handlers.values())) {
            const bindCore = (handler as Partial<CoreSchemeAdapter>).bindCore;
            if (typeof bindCore === "function") bindCore.call(handler, services);
        }
    }

    // {§exec} / #240 — exec OUTPUT entries address by their runtime TAG as authority
    // (sh:///l/t/s). Register each discovered executor as its OWN per-tag scheme face
    // (ExecOutputScheme): READ/FIND tag-scoped via the executor's manifest, process-KILL
    // delegated to the shared Exec handler. Minted from the boot ExecutorRegistry; in-tree
    // names take precedence (a tag shadowing a built-in is skipped, never overrides it).
    registerRuntimeSchemes(executors: ExecutorRegistry): void {
        for (const tag of executors.availableRuntimes()) {
            const entry = executors.entry(tag);
            if (entry === undefined) continue;
            this.registerRuntimeScheme(tag, entry.executor);
        }
    }

    // Register one executor tag's scheme face (the boot loop above or daemon-module setup).
    // The reserved/cross-family arbitration
    // lives HERE so both paths share it — one name, one owner across the exec/scheme families (#240):
    // idempotent on a tag that already has its own runtime scheme (a boot re-scan), fail-hard on a
    // collision with a reserved built-in or a DIFFERENT already-claimed scheme.
    registerRuntimeScheme(tag: string, executor: Executor, facet?: RuntimeSchemeFacet): void {
        const exec = this.#handlers.get("exec");
        if (!(exec instanceof Exec)) throw new Error("registerRuntimeScheme: the exec handler is not registered");
        if (this.#reserved.has(tag)) throw new Error(`executor tag '${tag}' collides with a reserved built-in scheme — fail-hard (#240)`);
        if (this.#runtimeSchemes.has(tag)) return; // idempotent — already this tag's own runtime scheme
        if (this.#handlers.has(tag)) throw new Error(`executor tag '${tag}' collides with an already-claimed scheme '${tag}' — one name, one owner across the exec/scheme families (#240)`);
        this.register(tag, new ExecOutputScheme(executor, exec, facet));
        this.#runtimeSchemes.add(tag);
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
    // address targets. Drives the manifest's address-keyed channels (note 4); null → file (body).
    defaultChannelFor(scheme: string | null): string {
        if (scheme === null) return "body";
        return this.manifestFor(scheme)?.defaultChannel ?? "body";
    }

    // The scheme directory — the `schemes` packet section (below tools). grammar
    // 0.49+ teaches grammar/dialects only, not the scheme set (grammar#239), so the
    // service advertises what schemes exist at packet-time. Each handler that ships a
    // `manifest.example` contributes ONE terse line — its canonical usage — plus a
    // pull doc when it ships `manifest.documentation` (materialized at
    // worker://plurnk/docs/<name>.md by LoopDocs, READ on demand). The verbose semantics live
    // in that pull doc, not here: terse pushes, depth pulls — exactly the exec tools
    // sheet's shape (#collectTools). Insertion order; a scheme with no example
    // (provisional, e.g. skill) is omitted. The doc's token weight rides its manifest entry.
    teach(): string {
        const lines: string[] = [];
        const excluded = docsExcludeSet();
        for (const [name, handler] of this.#handlers) {
            if (this.#runtimeSchemes.has(name)) continue; // {§exec} — runtime aliases route, but exec is taught once
            if (excluded.has(name)) continue; // #240 — PLURNK_SERVICE_DOCS_EXCLUDE drops the oneliner + the doc
            const manifest = this.manifestFor(name);
            const example = manifest?.example;
            if (typeof example !== "string" || example.length === 0) continue;
            lines.push(example); // bare op — the Schemes catalog is fenced, not bulleted (#436); doc links removed (#270)
        }
        // Scheme examples use the shared model-facing operation fence. {§packet-operation-fences}
        return lines.length > 0 ? `\`\`\`plurnk\n${lines.join("\n")}\n\`\`\`` : "";
    }

    // Scheme docs for materialization at worker://plurnk/docs/<name>.md.
    // A metaproject corpus entry wins; otherwise use manifest.documentation.
    docs(): Array<{ name: string; content: string }> {
        const out: Array<{ name: string; content: string }> = [];
        const excluded = docsExcludeSet();
        for (const [name, handler] of this.#handlers) {
            if (this.#runtimeSchemes.has(name)) continue; // {§exec} — runtime aliases share exec's doc, not their own
            if (excluded.has(name)) continue; // #240 — PLURNK_SERVICE_DOCS_EXCLUDE drops the doc
            const inline = this.manifestFor(name)?.documentation;
            const content = SCHEME_DOCS.get(name) ?? (typeof inline === "string" && inline.length > 0 ? inline : undefined);
            if (content !== undefined && content.length > 0) out.push({ name, content });
        }
        return out;
    }

    // {§scheme-packet-transform} {§packet-plugin-transform} — apply trusted
    // whole-list transforms in registration order. #73 owns boundary validation.
    async transformSections(sections: PacketSection[]): Promise<PacketSection[]> {
        let current = sections;
        for (const handler of this.#handlers.values()) {
            const transform = (handler as Partial<PacketSectionTransformer>).transformSections;
            if (typeof transform === "function") current = await transform.call(handler, current);
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
        const { schemes, skipped } = await SchemeDiscovery.discover({ cwd });
        for (const name of skipped) {
            console.warn(`scheme discovery: '${name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }
        for (const { name, packageName, exportName } of schemes) {
            if (this.#reserved.has(name)) throw new Error(`external scheme '${name}' (${packageName}) collides with a reserved built-in — boot fail-hard (#240)`);
            if (this.has(name)) continue; // idempotent re-scan
            // #473 — a multi-scheme package names each scheme's export (`plurnk.schemes[].export`);
            // absent = the classic single default export. A declared export that isn't a constructor
            // fails the boot hard — a manifest naming a missing class is a misdeclaration, not a skip.
            const mod = await import(packageName) as Record<string, new () => SchemeHandler>;
            const Handler = mod[exportName ?? "default"];
            if (typeof Handler !== "function") throw new Error(`external scheme '${name}' (${packageName}): export '${exportName ?? "default"}' is not a constructor — boot fail-hard (#473)`);
            this.register(name, new Handler());
            this.#attributions.push(...PluginAttribution.read(packageName)); // #249 — fail-hard if it claims @plurnk/
        }
    }

    // #249 — declared attribution tags of the discovered external schemes (opaque; the
    // engine unions these across plugin families onto the generate() `attributions` wire).
    attributions(): string[] { return [...this.#attributions]; }

    // Active set under the given loop flags (SPEC {§engine-rails}). Delegates to
    // the in-tree ResolveForLoop utility.
    resolveForLoop(flags: LoopFlags): Set<string> {
        return ResolveForLoop.resolveForLoop(this.#handlers, flags);
    }
}

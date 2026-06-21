import Plurnk from "../schemes/Plurnk.ts";
import Log from "../schemes/Log.ts";
import Exec from "../schemes/Exec.ts";
import Known from "../schemes/Known.ts";
import Unknown from "../schemes/Unknown.ts";
import Skill from "../schemes/Skill.ts";
import File from "../schemes/File.ts";
import Run from "../schemes/Run.ts";
import ResolveForLoop from "./resolveForLoop.ts";
import type { LoopFlags } from "./types.ts";
import { SchemeDiscovery, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type { PacketSection } from "./packet-wire.ts";
import type { PacketSectionTransformer } from "./scheme-types.ts";
import PluginAttribution from "./plugin-attribution.ts";
import ExecOutputScheme from "../schemes/ExecOutputScheme.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";

export default class SchemeRegistry {
    // Heterogeneous handler store — in-tree schemes take PlurnkSchemeContext, external
    // siblings the DB-free SchemeCtx of the imported SchemeHandler; the common supertype
    // is `object`. Dispatch (Engine.#run) borrows SchemeHandler's op-key set, not its ctx.
    #handlers = new Map<string, object>();
    #external = new Set<string>();
    #attributions: string[] = []; // #249 — declared attribution tags of discovered external schemes
    // §exec — runtime-tag schemes (sh/node/…) that ALIAS the exec handler for output-entry
    // addressing (sh:///l/t/s). Routable via get(), but NOT separately taught or doc-materialized
    // (exec is taught once); else the catalog + docs bloat by one redundant line/entry per tag.
    #runtimeSchemes = new Set<string>();

    constructor() {
        this.register("plurnk",  new Plurnk());
        this.register("log",     new Log());
        this.register("exec",    new Exec());
        this.register("known",   new Known());
        this.register("unknown", new Unknown());
        this.register("skill",   new Skill());
        this.register("file",    new File());
        this.register("run",     new Run());
    }

    register(name: string, handler: object): void {
        if (this.#handlers.has(name)) throw new Error(`scheme '${name}' is already registered`);
        this.#handlers.set(name, handler);
    }

    // §exec / #240 — exec OUTPUT entries address by their runtime TAG as authority
    // (sh:///l/t/s). Register each discovered executor as its OWN per-tag scheme face
    // (ExecOutputScheme): READ/FIND tag-scoped via the executor's manifest, process-KILL
    // delegated to the shared Exec handler. Minted from the boot ExecutorRegistry; in-tree
    // names take precedence (a tag shadowing a built-in is skipped, never overrides it).
    registerRuntimeSchemes(executors: ExecutorRegistry): void {
        const exec = this.#handlers.get("exec");
        if (!(exec instanceof Exec)) throw new Error("registerRuntimeSchemes: the exec handler is not registered");
        for (const tag of executors.availableRuntimes()) {
            if (this.#handlers.has(tag)) continue; // built-in / in-tree precedence
            const entry = executors.entry(tag);
            if (entry === undefined) continue;
            this.register(tag, new ExecOutputScheme(entry.executor, exec));
            this.#runtimeSchemes.add(tag);
        }
    }

    get(name: string): object | undefined { return this.#handlers.get(name); }

    has(name: string): boolean { return this.#handlers.has(name); }

    // True for schemes registered via discoverExternal — they receive the
    // DB-free SchemeCtx (caps), not the in-tree PlurnkSchemeContext.
    isExternal(name: string): boolean { return this.#external.has(name); }

    list(): string[] { return [...this.#handlers.keys()].toSorted(); }

    // A scheme's default channel (manifest.defaultChannel) — the channel a fragment-less
    // address targets. Drives the manifest's address-keyed channels (note 4); null → file (body).
    defaultChannelFor(scheme: string | null): string {
        if (scheme === null) return "body";
        const manifest = (this.#handlers.get(scheme)?.constructor as { manifest?: { defaultChannel?: string } })?.manifest;
        return manifest?.defaultChannel ?? "body";
    }

    // The scheme directory — the `schemes` packet section (below tools). grammar
    // 0.49+ teaches grammar/dialects only, not the scheme set (grammar#239), so the
    // service advertises what schemes exist at packet-time. Each handler that ships a
    // `manifest.example` contributes ONE terse line — its canonical usage — plus a
    // doc-link when it ships `manifest.documentation` (materialized at
    // plurnk://docs/<name>.md by loop_run, READ on demand). The verbose semantics live
    // in that pull doc, not here: terse pushes, depth pulls — exactly the exec tools
    // sheet's shape (#collectTools). Insertion order; a scheme with no example
    // (provisional, e.g. skill) is omitted. The doc's token cost rides its manifest entry.
    teach(): string {
        const lines: string[] = [];
        for (const [name, handler] of this.#handlers) {
            if (this.#runtimeSchemes.has(name)) continue; // §exec — runtime aliases route, but exec is taught once
            const manifest = (handler.constructor as { manifest?: { example?: string; documentation?: string } }).manifest;
            const example = manifest?.example;
            if (typeof example !== "string" || example.length === 0) continue;
            const docLink = typeof manifest?.documentation === "string" && manifest.documentation.length > 0 ? ` (docs: plurnk://docs/${name}.md)` : "";
            lines.push(`* ${name}:/// ${example}${docLink}`);
        }
        return lines.join("\n");
    }

    // #note12 — schemes that ship a `documentation` string, for materialization at
    // plurnk:///docs/<name>.md. Optional + currently none in-tree; future-proofs the link.
    docs(): Array<{ name: string; content: string }> {
        const out: Array<{ name: string; content: string }> = [];
        for (const [name, handler] of this.#handlers) {
            if (this.#runtimeSchemes.has(name)) continue; // §exec — runtime aliases share exec's doc, not their own
            const doc = (handler.constructor as { manifest?: { documentation?: string } }).manifest?.documentation;
            if (typeof doc === "string" && doc.length > 0) out.push({ name, content: doc });
        }
        return out;
    }

    // Plugin packet control (§packet-construction): pipe the engine's default
    // section list through every registered scheme that implements
    // transformSections, in registration order. A scheme returns whatever list it
    // wants — add, remove, reorder. The trusted in-process seam; the client wire
    // never touches the packet. In-tree + external handlers both, duck-typed.
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
    // is left as-is) and importing + registering the trusted descriptors. A sibling reaches
    // the substrate only through the DB-free SchemeCtx the engine wraps for isExternal() schemes.
    async discoverExternal(cwd: string = process.cwd()): Promise<void> {
        const { schemes, skipped } = await SchemeDiscovery.discover({ cwd });
        for (const name of skipped) {
            console.warn(`scheme discovery: '${name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }
        for (const { name, packageName } of schemes) {
            if (this.has(name)) continue; // in-tree precedence + idempotent re-scan
            const mod = await import(packageName) as { default: new () => SchemeHandler };
            this.register(name, new mod.default());
            this.#external.add(name);
            this.#attributions.push(...PluginAttribution.read(packageName)); // #249 — fail-hard if it claims @plurnk/
        }
    }

    // #249 — declared attribution tags of the discovered external schemes (opaque; the
    // engine unions these across plugin families onto the generate() `attributions` wire).
    attributions(): string[] { return [...this.#attributions]; }

    // Active set under the given loop flags (SPEC §engine-rails). Delegates to
    // the in-tree ResolveForLoop utility.
    resolveForLoop(flags: LoopFlags): Set<string> {
        return ResolveForLoop.resolveForLoop(this.#handlers, flags);
    }
}

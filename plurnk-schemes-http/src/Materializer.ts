import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Meta from "@plurnk/plurnk-meta";

// {§http-materializer-plugins} — the pluggable page-materialization contract.
// A third-party package declares `plurnk: { kind: "http-materializer", materializers:
// [{ id, module }] }` and exports one HttpMaterializer per entry. The operator
// selects one by id (`PLURNK_SCHEMES_HTTP_MATERIALIZER`); unset means the built-in
// local projection is the only body producer. The selected materializer is
// consulted for every HTML page the generic acquisition path materializes; its
// own eligibility (credentials, URL support) decides per request, and the
// built-in projection remains the fallback for recoverable outcomes.
//
// Discovery mirrors the executor family ({§plugin-discovery}): scope-agnostic
// package scan, trust gate ({§plugin-trust-boundary}), one flat id namespace —
// two packages claiming one id fail hard, never silently shadow.

export type MaterializerEvidence = ReadonlyArray<{ readonly name: string; readonly value: string }>;

export type MaterializerProblem = {
    readonly status: number;
    readonly code: string;
    readonly detail: string;
    readonly retryable: boolean;
};

export type MaterializerResult =
    | {
        readonly outcome: "success";
        readonly body: string;
        readonly identity: string;
        readonly evidence: MaterializerEvidence;
    }
    | {
        readonly outcome: "recoverable";
        readonly reason: string;
        readonly identity: string;
        readonly evidence: MaterializerEvidence;
        // The materializer's own failure Problem, used only when the local
        // projection fallback cannot produce a body either.
        readonly problem?: MaterializerProblem;
    }
    | {
        readonly outcome: "hard";
        readonly identity: string;
        readonly evidence: MaterializerEvidence;
        readonly problem: MaterializerProblem;
    };

export interface HttpMaterializer {
    readonly id: string;
    // Null when this materializer cannot serve the URL (unconfigured credentials,
    // unsupported target); otherwise the identity string recorded in the
    // materialization evidence headers.
    eligible(url: string, ctx: { signal?: AbortSignal }): Promise<string | null> | string | null;
    // Extract the sanitized readable body. Outcomes: success (the body is the
    // model-facing channel), recoverable (fall back to the local projection with
    // the recorded evidence), hard (the materialization fails with this Problem).
    extract(url: string, opts: { signal?: AbortSignal }): Promise<MaterializerResult>;
}

interface Manifest {
    readonly packageName: string;
    readonly materializers: Array<{ readonly id: string; readonly module: string }>;
}

export default class MaterializerRegistry {
    readonly #entries = new Map<string, { readonly packageName: string; readonly module: string; readonly dir: string }>();
    #promise: Promise<MaterializerRegistry> | null = null;

    // One process-wide lazy scan; the registry caches both the scan and the
    // loaded implementations.
    static current(): MaterializerRegistry {
        if (MaterializerRegistry.#current === null) {
            MaterializerRegistry.#current = new MaterializerRegistry();
        }
        return MaterializerRegistry.#current;
    }

    static #current: MaterializerRegistry | null = null;

    // Discover installed materializer packages under <cwd>/node_modules
    // (scope-agnostic), the same walk the executor family uses.
    async discover(options: { cwd?: string; packageDirs?: Array<{ dir: string; name: string }> } = {}): Promise<MaterializerRegistry> {
        this.#promise ??= (async (): Promise<MaterializerRegistry> => {
            const dirs = options.packageDirs ?? await Meta.packageDirs(path.join(options.cwd ?? process.cwd(), "node_modules"));
            for (const candidate of dirs) {
                const manifest = await MaterializerRegistry.#readManifest(candidate.dir);
                if (manifest === null) continue;
                if (!Meta.isTrusted(manifest.packageName)) continue;
                for (const entry of manifest.materializers) {
                    const prior = this.#entries.get(entry.id);
                    if (prior !== undefined) {
                        throw new Error(
                            `http materializer '${entry.id}' is claimed by both ${prior.packageName} and ${manifest.packageName} — one flat id namespace.`,
                        );
                    }
                    this.#entries.set(entry.id, { packageName: manifest.packageName, module: entry.module, dir: candidate.dir });
                }
            }
            return this;
        })();
        return this.#promise;
    }

    materializerFor(id: string): HttpMaterializer | null {
        const entry = this.#entries.get(id);
        if (entry === undefined) return null;
        return {
            id,
            eligible: async (...args) => (await this.#load(entry)).eligible(...args),
            extract: async (...args) => (await this.#load(entry)).extract(...args),
        };
    }

    #loaded = new Map<string, Promise<HttpMaterializer>>();

    #load(entry: { dir: string; module: string }): Promise<HttpMaterializer> {
        const key = `${entry.dir}:${entry.module}`;
        const cached = this.#loaded.get(key);
        if (cached !== undefined) return cached;
        const promise = (async (): Promise<HttpMaterializer> => {
            const module = await import(pathToFileURL(path.join(entry.dir, entry.module)).href) as {
                default?: HttpMaterializer | { new(): HttpMaterializer };
            };
            const exported = module.default;
            if (typeof exported === "function") return new exported();
            if (exported !== undefined && typeof exported === "object" && "eligible" in exported) return exported;
            throw new Error(`http materializer module '${entry.module}' exports no HttpMaterializer default`);
        })();
        this.#loaded.set(key, promise);
        return promise;
    }

    static async #readManifest(dir: string): Promise<Manifest | null> {
        let raw: string;
        try {
            raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
        } catch {
            return null;
        }
        let pkg: Record<string, unknown>;
        try {
            pkg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return null;
        }
        const plurnk = pkg.plurnk;
        if (!Meta.declaresKind(plurnk, "http-materializer")) return null;
        const declared = (plurnk as { materializers?: unknown }).materializers;
        if (!Array.isArray(declared) || declared.length === 0) return null;
        const materializers: Manifest["materializers"] = [];
        for (const entry of declared) {
            if (typeof entry !== "object" || entry === null) continue;
            const id = (entry as { id?: unknown }).id;
            const module = (entry as { module?: unknown }).module;
            if (typeof id !== "string" || id.length === 0 || typeof module !== "string" || module.length === 0) continue;
            materializers.push({ id, module });
        }
        if (materializers.length === 0) return null;
        return { packageName: String(pkg.name ?? path.basename(dir)), materializers };
    }
}

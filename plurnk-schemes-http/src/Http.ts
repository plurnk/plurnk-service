// HTTP(S) handler. Operation-to-method semantics live in {§http-manifest};
// acquisition, materialization, publication, and query flow live in
// {§http-lifecycle} and {§http-status}. The implementation depends only on SchemeCtx capabilities.

import { Validator } from "@plurnk/plurnk-contracts";
import type {
    KillStatement,
    PassthroughResult,
    ProposalApplyRequest,
    ProposalApplyResult,
    ProposalResult,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    ResolvedEditStatement,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
    SendStatement,
    UrlPath,
    WebMaterializer,
} from "@plurnk/plurnk-schemes";
import { MetadataOptions, NetworkAddress } from "@plurnk/plurnk-schemes";
import { readFile } from "node:fs/promises";
import HttpGet from "./HttpGet.ts";
import HttpRequester from "./HttpRequester.ts";
import {
    BODY,
    HTTP_CHANNELS,
    LiveAcquisitions,
    OUTBOUND_METHODS,
    httpAddress,
    httpBad,
    httpPassthrough,
} from "./HttpShared.ts";
import WebFetcher from "./WebFetcher.ts";

// The package-shipped model teaching is loaded verbatim and fails hard if absent.
// The relative path is identical from src/ during development and dist/ after build.
const documentation = await readFile(new URL("../docs/https.md", import.meta.url), "utf-8");

export default class Http implements SchemeHandler {
    static manifest: SchemeManifest = {
        // "https" is the registered face — plain http folds into it exactly as
        // ws folds into wss ({§http-manifest}); supported, never advertised as
        // a peer endpoint.
        name: "https",
        authority: "resource",
        // Channel mimetypes here are SEED DEFAULTS (pre-fetch placeholders).
        // body is retyped per-call to the real response Content-Type;
        // octet-stream is the honest "unknown until fetched". header is always the status
        // line + headers (text/plain).
        // {§channel-selection} — body is the response as served (a page's server source); readable
        // is curated Markdown or binary facts; header is transport evidence.
        channels: { ...HTTP_CHANNELS },
        defaultChannel: BODY,
        category: "data",
        writableBy: ["model", "client"],
        volatile: true,        // remote content can change between fetches
        modelVisible: true,
        metadataModifier: true,
        glyph: "🌐",
        documentation,
        traits: ["web"],
    };

    readonly #webFetcher: WebFetcher;
    // {§scheme-operation-dispatch}: published for the entry sink; reached through the registry.
    readonly webMaterializer: WebMaterializer;
    // {§http-lifecycle} — one opportunistic origin-companion attempt per TTL
    // window; success and failure share the timer so a 404 does not re-probe
    // on every READ.
    readonly #get: HttpGet;
    readonly #requester: HttpRequester;
    readonly #live = new LiveAcquisitions();

    constructor() {
        this.#webFetcher = new WebFetcher();
        this.webMaterializer = this.#webFetcher;
        this.#get = new HttpGet({ live: this.#live, webFetcher: this.#webFetcher });
        this.#requester = new HttpRequester({ live: this.#live, manifest: Http.manifest });
    }

    async ready(): Promise<void> {
        WebFetcher.validateConfiguration();
    }

    // Representation preparation is scope-blind. Core applies the authored READ
    // coordinates only after this hook has either materialized a finite GET or
    // returned 102 for a retained SSE response.
    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.target.kind !== "url") {
            return httpBad(400, "http", "bad-target", "READ requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        return this.#get.prepareGet(request.target, request.metadata, request.pathname, ctx);
    }

    // EDIT -> PUT the body (full-resource replace). `<L>` has no meaning against a
    // remote resource - reject rather than silently ignore the model's intent.
    async editBatch(statements: readonly ResolvedEditStatement[], _ctx: SchemeCtx): Promise<PassthroughResult | ProposalResult> {
        if (statements.length !== 1) {
            return httpBad(
                409,
                "http",
                "non-atomic-edit-batch",
                `${statements.length} EDIT statements cannot be committed atomically to one remote resource.`,
                {
                    statements: statements.length,
                    stage: "mutation",
                    recovery: "Submit one whole-resource EDIT.",
                    retryable: false,
                },
            );
        }
        const statement = statements[0];
        if (statement.target === null || statement.target.kind !== "url") {
            return httpBad(400, "http", "bad-target", "EDIT requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        if (statement.lineMarker !== null) {
            return httpBad(
                400,
                "http",
                "line-edit-unsupported",
                "HTTP EDIT replaces the whole remote resource and does not accept a line range.",
                {
                    stage: "mutation",
                    recovery: "Remove the line range and submit the complete replacement body.",
                    retryable: false,
                },
            );
        }
        return Http.#propose("PUT", statement.target, statement.body ?? "");
    }

    async edit(statement: ResolvedEditStatement, ctx: SchemeCtx): Promise<PassthroughResult | ProposalResult> {
        return this.editBatch([statement], ctx);
    }

    // {§revalidation} — KILL follows the entry rule: a live acquisition of the address is
    // cancelled, otherwise the stored response is forgotten. The remote DELETE is its own
    // spelling, `KILL (https://…) [{"remote": true}]`; any other metadata keys are its headers.
    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<PassthroughResult | ProposalResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return httpBad(400, "http", "bad-target", "KILL requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        const read = MetadataOptions.parse(statement.metadata, "scheme:http");
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a metadata refusal has no shape; the method's result type names the success's passthrough shape
        if ("failure" in read) return read.failure as PassthroughResult;
        // The `remote` spelling is stripped in applyResolution, where the request is actually made.
        if (read.options.remote === true) return Http.#propose("DELETE", statement.target);
        const address = httpAddress(statement.target);
        if (!(address instanceof NetworkAddress)) return address;
        if (this.#live.cancel(LiveAcquisitions.key(ctx.workspaceId, address.url))) {
            // The owner settles itself as cancelled through its aborted signal.
            return { shape: "passthrough", status: 200 };
        }
        return httpPassthrough(await ctx.entries.delete(address.pathname));
    }

    // {§http-manifest} — a request that changes a remote resource declares the host
    // effect and proposes; `PLURNK_SERVICE_EFFECT_HOST` decides whether that settles by consent
    // or runs unattended. The headers stay OUT of attrs: they ride the statement metadata across
    // the pause, so an `Authorization` value never enters durable proposal evidence.
    static #propose(method: string, target: UrlPath, body?: string): ProposalResult {
        return {
            shape: "proposal",
            status: 202,
            body: `${method} ${target.raw}`,
            attrs: { effect: "host", method, target, ...(body === undefined ? {} : { body }) },
        };
    }

    async applyResolution(request: ProposalApplyRequest, ctx: SchemeCtx): Promise<ProposalApplyResult> {
        const attrs = request.attrs as { method?: unknown; target?: unknown; body?: unknown };
        const { method, target } = attrs;
        if (typeof target !== "object" || target === null) {
            throw new Error("An outbound HTTP proposal is missing its target.");
        }
        const url = Validator.assertParsedPath(target);
        if (url.kind !== "url") throw new Error("An outbound HTTP proposal's target is a URL.");
        // This scheme mints exactly three outbound methods; a settlement never widens that set.
        if (typeof method !== "string" || !OUTBOUND_METHODS.has(method)) {
            throw new Error(`An outbound HTTP proposal named a method this scheme never proposes: ${String(method)}.`);
        }
        // The resolver may replace an authored body before it is sent; a bodyless verb keeps none.
        const body = attrs.body === undefined ? undefined : request.body ?? (typeof attrs.body === "string" ? attrs.body : JSON.stringify(attrs.body));
        // DELETE spells its intent with `remote`, which selects the verb and is never a header.
        let metadata = request.metadata;
        if (method === "DELETE") {
            const read = MetadataOptions.parse(metadata, "scheme:http");
            if ("failure" in read) return read.failure;
            const { remote: _remote, ...headers } = read.options;
            metadata = Object.keys(headers).length === 0 ? null : [JSON.stringify(headers)];
        }
        return this.#requester.request(url, metadata, ctx, method, body);
    }

    // {§op-shapes} — SEND is messaging; lifecycle operations never reach a scheme.
    async send(statement: SendStatement, _ctx: SchemeCtx): Promise<PassthroughResult | ProposalResult> {
        if (statement.target === null || statement.target.kind !== "url") {
            return httpBad(400, "http", "bad-target", "SEND requires an http(s):// URL target.", {
                stage: "target-validation",
                recovery: "Provide an http(s):// URL target.",
                retryable: false,
            });
        }
        return Http.#propose("POST", statement.target, statement.body?.raw ?? "");
    }
}

import { SkillResourceError, type SkillTree } from "@plurnk/plurnk-agent-skills";
import { PathSyntax, type FindStatement, type ParsedPath } from "@plurnk/plurnk-contracts";
import { MimetypeInputLimitError } from "@plurnk/plurnk-mimetypes";
import {
    GeneratedByteSource,
    type ByteSource,
    type EntryAddress,
    type EntryCoordinate,
    type RepresentationPreparationRequest,
    type RepresentationPreparationResult,
    type SchemeHandler,
    type SchemeManifest,
} from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase, type CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { entryCoordinateOf } from "../core/plurnk-uri.ts";
import FileMaterialization from "../core/file-materialization.ts";
import MimetypeBinary from "../content/mimetype-binary.ts";
import Results from "../core/results.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryFind, { emptyFindFields, type FindResult } from "./_entry-find.ts";
import { pathScope, pathScopeMatches } from "./_path-scope.ts";

// {§skills-resources} The resource tree is truth; entries are demand-loaded projections.
export default class Skill extends CoreSchemeAdapterBase implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "skill",
        authority: "resource",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["_plurnk", "plugin"],
        volatile: false,
        folderScopes: true,
        modelVisible: true,
    };

    readonly #trees: (workspaceId: number) => ReadonlyMap<string, SkillTree>;

    constructor(trees: (workspaceId: number) => ReadonlyMap<string, SkillTree>) {
        super();
        this.#trees = trees;
    }

    async resolveEntryAddress(target: ParsedPath, ctx: CoreSchemeCallContext): Promise<EntryAddress | null> {
        const address = entryCoordinateOf(target, "resource");
        const trees = this.#trees(ctx.workspaceId);
        return PathSyntax.hasGlob(address.authority) || trees.has(address.authority) ? address : null;
    }

    byteSource({ authority, pathname }: EntryCoordinate, ctx: CoreSchemeCallContext): ByteSource {
        return this.#trees(ctx.workspaceId).get(authority)?.resource(pathname.replace(/^\//u, ""))
            ?? new GeneratedByteSource(async () => null);
    }

    static #refusal(cause: unknown, address: EntryCoordinate): RepresentationPreparationResult {
        const target = `skill://${address.authority}${address.pathname}`;
        if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") {
            return Results.failure("scheme:skill", "entry-not-found", 404, `No skill resource exists at ${target}.`, {}, { target });
        }
        if (cause instanceof SkillResourceError) {
            const outside = cause.code === "SKILL_PATH_OUTSIDE_ROOT";
            return Results.failure("scheme:skill", outside ? "resource-outside-root" : "resource-invalid", outside ? 403 : 400, cause.message, {}, { target });
        }
        throw cause;
    }

    async #materialize(address: EntryCoordinate, core: PlurnkSchemeContext): Promise<RepresentationPreparationResult> {
        try {
            const source = this.byteSource(address, core);
            const size = await source.size();
            if (size === null) return Skill.#refusal({ code: "ENOENT" }, address);
            const mimetypes = core.mimetypes;
            if (mimetypes === undefined) throw new Error("Skill requires the configured mimetype registry.");
            const mimetype = await FileMaterialization.detectSourceMimetype(address.pathname, source, mimetypes);
            let content = "";
            let outputMimetype = mimetype;
            let attributes: Readonly<Record<string, unknown>> = {};
            if (await MimetypeBinary.isBinaryMimetype(mimetype, mimetypes)) {
                let metadata: Readonly<Record<string, unknown>> = { mimetype };
                try {
                    const projected = await mimetypes.projectReadableStream(Skill.#chunks(source, size), mimetype);
                    if (projected !== null) {
                        content = projected.content;
                        outputMimetype = "text/markdown";
                        metadata = { mimetype: projected.sourceMimetype, facts: projected.facts };
                    }
                } catch (cause) {
                    if (!(cause instanceof MimetypeInputLimitError)) throw cause;
                    metadata = { mimetype, maximumBytes: cause.maximumBytes, observedBytes: cause.observedBytes };
                }
                attributes = { sourceProjection: metadata };
            } else {
                const materialization = FileMaterialization.classify(size);
                if (materialization.disposition === "input-limit") {
                    const rejection = FileMaterialization.rejection(`skill://${address.authority}${address.pathname}`, materialization);
                    return Results.failure("scheme:skill", rejection.code, rejection.status, rejection.detail, {}, rejection.extensions);
                }
                content = new TextDecoder().decode(await source.read(1, size));
            }
            const written = await EntryCrud.writeEntry(address, {
                channels: { body: { content, mimetype: outputMimetype } },
                attributes,
            }, core, "skill");
            return written.status >= 400 ? written : { status: 200 };
        } catch (cause) {
            return Skill.#refusal(cause, address);
        }
    }

    static async *#chunks(source: ByteSource, size: number): AsyncGenerator<Uint8Array> {
        for (let start = 1; start <= size; start += 65536) {
            yield await source.read(start, Math.min(start + 65535, size));
        }
    }

    prepareRepresentation(request: RepresentationPreparationRequest, ctx: CoreSchemeCallContext): Promise<RepresentationPreparationResult> {
        return this.#materialize(request, this.coreContext(ctx));
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        if (statement.target === null) return { ...emptyFindFields(), ...Results.failure("scheme:skill", "target-required", 400, "FIND requires a skill resource target.") };
        const coordinate = entryCoordinateOf(statement.target, "resource");
        const authorityScope = pathScope(coordinate.authority, false);
        const scope = pathScope(coordinate.pathname, true);
        const inScope = (pathname: string): boolean => scope.kind === "glob" && scope.shallowPrefix !== null
            ? pathname.startsWith(scope.shallowPrefix)
            : pathScopeMatches(scope, pathname);
        const trees = this.#trees(core.workspaceId);
        const available = new Set<string>();
        for (const [authority, tree] of trees) {
            if (!pathScopeMatches(authorityScope, authority)) continue;
            try {
                const paths = scope.kind === "exact"
                    ? [scope.pathname.replace(/^\//u, "")]
                    : await tree.list();
                for (const relative of paths) {
                    const pathname = `/${relative}`;
                    // A shallow FIND also needs deeper names for its folder summaries.
                    if (!inScope(pathname)) continue;
                    const prepared = await this.#materialize({ authority, pathname }, core);
                    if (prepared.status === 404) continue;
                    if (prepared.status !== 200) return { ...emptyFindFields(), ...prepared };
                    available.add(`${authority}\0${pathname}`);
                }
            } catch (cause) {
                return { ...emptyFindFields(), ...Skill.#refusal(cause, { authority, pathname: coordinate.pathname }) };
            }
        }
        const cached = await core.db.find_workspace_entry_candidate_ids.all<EntryCoordinate>({
            workspace_id: core.workspaceId, scheme: "skill",
            authority: null, scope_prefix: null, channel: "body",
        });
        for (const address of cached) {
            if (!trees.has(address.authority)
                || (pathScopeMatches(authorityScope, address.authority)
                    && inScope(address.pathname)
                    && !available.has(`${address.authority}\0${address.pathname}`))) {
                await EntryCrud.deleteEntry(address, core, "skill");
            }
        }
        return EntryFind.findWorkspaceEntries(statement, core, Skill.manifest, {
            bytes: (pathname, authority) => this.byteSource({ authority, pathname }, core),
        });
    }
}

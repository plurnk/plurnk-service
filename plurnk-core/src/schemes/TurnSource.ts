import { PathSyntax, type FindStatement, type ParsedPath, type UrlPath } from "@plurnk/plurnk-contracts";
import type { SchemeManifest } from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase, type CoreRepresentationProvider, type CoreRepresentationResolution, type CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results from "../core/results.ts";
import { contentWeight } from "../core/content-weight.ts";
import LogVisibility from "../core/LogVisibility.ts";
import Matcher, { type CandidateMatch } from "../content/matcher.ts";
import EntryFts from "./_entry-fts.ts";
import EntryGraph from "./_entry-graph.ts";
import { emptyFindFields, projectFindResult, type FindResult, type FindProjectionResource } from "./_entry-find.ts";
import { pathScope, pathScopeMatches, pathFolderSummaries } from "./_path-scope.ts";
import { resolveSearchCandidates } from "./_search-candidate.ts";
import { renderAddress } from "../core/plurnk-uri.ts";

type Source = { authority: string; pathname: string; content: string; deep_hash: string | null };

// {§turn-source-resources}: immutable, worker-qualified history within a workspace.
export default class TurnSource extends CoreSchemeAdapterBase implements CoreRepresentationProvider {
    readonly manifest: SchemeManifest;
    readonly #kind: "ops" | "reasoning" | "note";
    readonly #mimetype: string;

    constructor(kind: "ops" | "reasoning" | "note") {
        super();
        this.#kind = kind;
        this.#mimetype = kind === "ops" ? "text/vnd.plurnk" : "text/plain";
        this.manifest = {
            name: kind, authority: "resource", channels: { body: this.#mimetype }, defaultChannel: "body",
            category: "logging", writableBy: [], volatile: false, modelVisible: true,
            folderScopes: true, textEditScopes: true,
        };
    }

    #failure(status: number, code: string, detail: string) {
        return Results.failure(`scheme:${this.#kind}`, code, status, detail, { content: null, mimetype: null, channel: null });
    }

    #named(target: ParsedPath | null): target is UrlPath & { hostname: string } {
        return target?.kind === "url" && target.hostname !== null && target.hostname.length > 0
            && [target.username, target.password, target.port, target.query].every((value) => value === null);
    }

    async resolveCoreRepresentation(target: ParsedPath | null, context: CoreSchemeCallContext): Promise<CoreRepresentationResolution> {
        const { db, workspaceId } = this.coreContext(context);
        const pathname = target?.kind === "url" ? target.pathname : target?.raw;
        const coordinate = (this.#kind === "note" ? /^\/(\d+)\/(\d+)\/(\d+)\/?$/ : /^\/(\d+)\/(\d+)\/?$/).exec(pathname ?? "");
        if (!this.#named(target) || coordinate === null) return { result: this.#failure(
            400, "coordinate-malformed", `Use ${this.#kind}://<worker>/<loop>/<turn>${this.#kind === "note" ? "/<item>" : ""}, without userinfo, a port, or a query.`,
        ) };
        const row = await db.turn_source_read.get<{ content: string | null }>({
            workspace_id: workspaceId, worker_name: target.hostname,
            loop_seq: Number(coordinate[1]), turn_seq: Number(coordinate[2]), kind: this.#kind,
            sequence: Number(coordinate[3] ?? 0),
        });
        if (row === undefined) return { result: this.#failure(404, "entry-not-found", `No ${this.#kind} source exists at ${target.raw}.`) };
        // An existing turn without a source of this kind is empty, not missing: the coordinate is
        // real, the provider simply returned nothing there.
        return {
            identity: renderAddress({ scheme: this.#kind, authority: target.hostname, pathname: `/${coordinate.slice(1).join("/")}` }),
            representation: { channels: { body: { content: row.content ?? "", mimetype: this.#mimetype, state: "static" } } },
        };
    }

    async find(statement: FindStatement, context: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(context);
        const { db, workspaceId, mimetypes } = core;
        if (mimetypes === undefined) throw new Error("TurnSource.find requires mimetypes.");
        const target = statement.target;
        const failed = (status: number, code: string, detail: string): FindResult => ({ ...this.#failure(status, code, detail), ...emptyFindFields() });
        if (!this.#named(target)) return failed(400, "coordinate-malformed", `Use ${this.#kind}://<worker>/ with loop/turn coordinates or a path pattern, without userinfo, a port, or a query.`);
        const pathname = target.pathname;
        const authorityScope = pathScope(target.hostname, false);
        const scope = pathScope(/^\/\d+$/.test(pathname) ? `${pathname}/` : pathname, true);
        const load = async () => (await db.turn_source_candidates.all<Source>({
            workspace_id: workspaceId, worker_name: PathSyntax.hasGlob(target.hostname) ? null : target.hostname, kind: this.#kind,
        })).filter((row) => pathScopeMatches(authorityScope, row.authority)).map((row) => ({
            ...row, key: renderAddress({ scheme: this.#kind, authority: row.authority, pathname: row.pathname }),
        }));
        let all = await load();
        const matcher = statement.matcher;
        const relation = matcher !== null && (matcher.dialect === "fts" || matcher.dialect === "graph") ? matcher : null;
        if (relation !== null && all.some(({ deep_hash }) => deep_hash === null) && core.settleDerivations !== undefined) {
            await core.settleDerivations();
            all = await load();
        }
        const selected = all.filter((row) => pathScopeMatches(scope, row.pathname));
        if (authorityScope.kind === "exact" && scope.kind === "exact" && selected.length === 0) return failed(404, "entry-not-found", `No ${this.#kind} source exists at ${target.raw}.`);
        const projections = selected.map(({ key, content }) => ({ key, content, mimetype: this.#mimetype }));
        let matches: CandidateMatch[];
        if (relation !== null) {
            const candidates = resolveSearchCandidates(selected.map(({ key, deep_hash: deepHash }) => ({ key, deepHash })));
            const universe = resolveSearchCandidates(all.map(({ key, deep_hash: deepHash }) => ({ key, deepHash })));
            if (candidates.state !== "ready" || universe.state !== "ready") return failed(503, "search-index-incomplete", "The persistent search index does not yet cover the selected history.");
            if (relation.dialect === "fts") {
                const result = await EntryFts.rankCandidates(db, candidates.candidates, relation.raw.slice(1), core.signal);
                if (result.status !== 200) return { ...result, ...emptyFindFields() };
                matches = result.matches;
            } else {
                const result = await EntryGraph.matchCandidates(db, universe.candidates, candidates.candidates, relation.raw);
                if (result.status !== 200) return failed(result.status, "invalid-expression", "Malformed graph matcher; expected &symbol, &<symbol, or &>symbol.");
                matches = Matcher.addTextRegions(result.matches.map(({ key, lineStart, lineEnd }) => ({ key, span: { lineStart, lineEnd } })), projections);
            }
        } else if (statement.matcher !== null) {
            const result = await Matcher.matchCandidates(statement.matcher, projections, mimetypes);
            if (result.status !== 200) return { ...result, ...emptyFindFields() };
            matches = result.matches;
        } else {
            matches = selected.map(({ key }) => ({ key, matches: [] }));
        }
        const weigh = core.weigh ?? contentWeight;
        const byPath = new Map(all.map((row) => [row.key, row]));
        const resources: FindProjectionResource[] = matches.map(({ key, matches: evidence }) => {
            const row = byPath.get(key)!;
            return {
                item: [{ path: key, mimetype: this.#mimetype, weight: weigh(row.content), lines: LogVisibility.lineCount(row.content) }],
                match: { pathname: key, matches: evidence },
            };
        });
        const folders = statement.matcher === null ? [...Map.groupBy(all, (row) => row.authority)]
            .flatMap(([authority, rows]) => pathFolderSummaries(scope, rows.map(({ pathname }) => pathname))
                .map(({ selector, pathnames }) => ({
                    path: renderAddress({ scheme: this.#kind, authority, pathname: selector }), items: pathnames.length,
                    weight: pathnames.reduce((sum, pathname) => sum + weigh(byPath.get(renderAddress({ scheme: this.#kind, authority, pathname }))!.content), 0),
                }))) : [];
        const projectionScope = authorityScope.kind === "glob" ? authorityScope : scope;
        return projectFindResult(statement, projectionScope, resources, folders);
    }
}

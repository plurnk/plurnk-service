import type { FindStatement, ParsedPath } from "@plurnk/plurnk-contracts";
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

type Source = { pathname: string; content: string; deep_hash: string | null };

// {§turn-source-resources}: two read-only views of the current worker's history.
export default class TurnSource extends CoreSchemeAdapterBase implements CoreRepresentationProvider {
    readonly manifest: SchemeManifest;
    readonly #kind: "ops" | "reasoning";
    readonly #mimetype: string;

    constructor(kind: "ops" | "reasoning") {
        super();
        this.#kind = kind;
        this.#mimetype = kind === "ops" ? "text/vnd.plurnk" : "text/plain";
        this.manifest = {
            name: kind, channels: { body: this.#mimetype }, defaultChannel: "body",
            category: "logging", writableBy: [], volatile: false, modelVisible: true,
            folderScopes: true, textEditScopes: true,
        };
    }

    #failure(status: number, code: string, detail: string) {
        return Results.failure(`scheme:${this.#kind}`, code, status, detail, { content: null, mimetype: null, channel: null });
    }

    #local(target: ParsedPath | null): boolean {
        return target !== null && (target.kind !== "url" || [target.hostname, target.username, target.password, target.port].every((value) => value === null));
    }

    async resolveCoreRepresentation(target: ParsedPath | null, context: CoreSchemeCallContext): Promise<CoreRepresentationResolution> {
        const { db, workerId } = this.coreContext(context);
        const pathname = target?.kind === "url" ? target.pathname : target?.raw;
        const coordinate = /^\/(\d+)\/(\d+)\/?$/.exec(pathname ?? "");
        if (!this.#local(target) || coordinate === null) return { result: this.#failure(
            400, "coordinate-malformed", `Use ${this.#kind}:///<loop>/<turn>.`,
        ) };
        const row = await db.turn_source_read.get<{ content: string | null }>({
            worker_id: workerId, loop_seq: Number(coordinate[1]), turn_seq: Number(coordinate[2]), kind: this.#kind,
        });
        if (row === undefined) return { result: this.#failure(404, "entry-not-found", `No turn exists at ${target!.raw}.`) };
        // An existing turn without a source of this kind is empty, not missing: the coordinate is
        // real, the provider simply returned nothing there.
        return {
            identity: `${this.#kind}:///${coordinate[1]}/${coordinate[2]}`,
            representation: { channels: { body: { content: row.content ?? "", mimetype: this.#mimetype, state: "static" } } },
        };
    }

    async find(statement: FindStatement, context: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(context);
        const { db, workerId, mimetypes } = core;
        if (mimetypes === undefined) throw new Error("TurnSource.find requires mimetypes.");
        const target = statement.target;
        const failed = (status: number, code: string, detail: string): FindResult => ({ ...this.#failure(status, code, detail), ...emptyFindFields() });
        if (!this.#local(target)) return failed(400, "coordinate-malformed", `Use ${this.#kind}:/// with loop/turn coordinates or a path pattern.`);
        const pathname = target!.kind === "url" ? target!.pathname : target!.raw;
        const scope = pathScope(/^\/\d+$/.test(pathname) ? `${pathname}/` : pathname, true);
        const load = () => db.turn_source_candidates.all<Source>({ worker_id: workerId, kind: this.#kind });
        let all = await load();
        const relation = statement.body?.dialect === "fts" || statement.body?.dialect === "graph";
        if (relation && all.some(({ deep_hash }) => deep_hash === null) && core.settleDerivations !== undefined) {
            await core.settleDerivations();
            all = await load();
        }
        const selected = all.filter((row) => pathScopeMatches(scope, row.pathname));
        if (scope.kind === "exact" && selected.length === 0) return failed(404, "entry-not-found", `No ${this.#kind} source exists at ${target!.raw}.`);
        const projections = selected.map(({ pathname: key, content }) => ({ key, content, mimetype: this.#mimetype }));
        let matches: CandidateMatch[];
        if (relation) {
            const candidates = resolveSearchCandidates(selected.map(({ pathname: key, deep_hash: deepHash }) => ({ key, deepHash })));
            const universe = resolveSearchCandidates(all.map(({ pathname: key, deep_hash: deepHash }) => ({ key, deepHash })));
            if (candidates.state !== "ready" || universe.state !== "ready") return failed(503, "search-index-incomplete", "The persistent search index does not yet cover the selected history.");
            if (statement.body!.dialect === "fts") {
                const result = await EntryFts.rankCandidates(db, candidates.candidates, statement.body!.raw.slice(1), core.signal);
                if (result.status !== 200) return { ...result, ...emptyFindFields() };
                matches = result.matches;
            } else {
                const result = await EntryGraph.matchCandidates(db, universe.candidates, candidates.candidates, statement.body!.raw);
                if (result.status !== 200) return failed(result.status, "invalid-expression", "Malformed graph matcher; expected &symbol, &<symbol, or &>symbol.");
                matches = Matcher.addTextRegions(result.matches.map(({ key, lineStart, lineEnd }) => ({ key, span: { lineStart, lineEnd } })), projections);
            }
        } else if (statement.body !== null) {
            const result = await Matcher.matchCandidates(statement.body, projections, mimetypes);
            if (result.status !== 200) return { ...result, ...emptyFindFields() };
            matches = result.matches;
        } else {
            matches = selected.map(({ pathname: key }) => ({ key, matches: [] }));
        }
        const weigh = core.weigh ?? contentWeight;
        const byPath = new Map(all.map((row) => [row.pathname, row]));
        const resources: FindProjectionResource[] = matches.map(({ key, matches: evidence }) => {
            const row = byPath.get(key)!;
            return {
                item: [{ path: `${this.#kind}://${key}`, mimetype: this.#mimetype, weight: weigh(row.content), lines: LogVisibility.lineCount(row.content) }],
                match: { pathname: key, matches: evidence },
            };
        });
        const folders = statement.body === null ? pathFolderSummaries(scope, all.map(({ pathname }) => pathname)).map(({ selector, pathnames }) => ({
            path: `${this.#kind}://${selector}`, items: pathnames.length,
            weight: pathnames.reduce((sum, key) => sum + weigh(byPath.get(key)!.content), 0),
        })) : [];
        return projectFindResult(statement, scope, resources, folders);
    }
}

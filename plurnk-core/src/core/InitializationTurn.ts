import { PlurnkParser } from "@plurnk/plurnk-parser";
import {
    PathSyntax, UNKNOWN_POSITION,
    type CapabilityPolicy, type FindStatement, type NoteStatement, type ReadStatement, type UrlPath,
} from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type CapabilityResolver from "./CapabilityResolver.ts";
import type Dispatcher from "./Dispatcher.ts";
import type AdmittedTurnExecutor from "./AdmittedTurnExecutor.ts";
import type { ContextFit } from "./ContextFit.ts";
import Turn, { type TurnRow } from "./Turn.ts";
import TurnOps from "./TurnOps.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import { generatedPathname } from "./plurnk-uri.ts";

const regexLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const workspaceCatalogTarget = (
    namespace: "plurnk" | "tools",
): UrlPath => {
    const pathname = generatedPathname(`/${namespace}/*.md`);
    return {
        kind: "url",
        raw: `workspace://${pathname}`,
        scheme: "workspace",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    };
};

// PLURNK_SERVICE_FILES_ITEMS — the turn-0 catalog preview. null = off;
// -1 = the ordinary markerless page; positive N explicitly caps file rows. 0 / unset = off.
const normalizeFilesItems = (n: number): number | null => (!Number.isFinite(n) || n === 0 ? null : n < 0 ? -1 : n);
const readFilesItems = (): number | null => {
    const raw = process.env.PLURNK_SERVICE_FILES_ITEMS;
    if (raw === undefined || raw.length === 0) return null;
    return normalizeFilesItems(Number.parseInt(raw, 10));
};

// {§session-initialization-entry} — the two NOTEs that open and close the initialization surveys, both
// labelled as the card's own plan example is: the session's plan in steps, then its next step.
const INITIALIZATION_NOTE: NoteStatement = {
    op: "NOTE", aside: "plan", metadata: null, target: null, lineMarker: null,
    body: ["1. Survey the environment.", "2. Evaluate and react to the Open Message."].join("\n"),
    position: UNKNOWN_POSITION,
};
const INITIALIZATION_CLOSING_NOTE: NoteStatement = {
    op: "NOTE", aside: "plan", metadata: null, target: null, lineMarker: null,
    body: "Evaluate and react to the Open Message.", position: UNKNOWN_POSITION,
};

export default class InitializationTurn {
    // {§session-initialization-entry} — the session's first turn is the worked
    // example itself: the actual orienting operations.
    // {§session-initialization-entry} — the project AGENTS.md, its AGENTS.local.md (materialized
    // by LoopDocs under workspace:///_plurnk/), and session://<session>/AGENTS.md when pre-populated
    // in the session's scratch namespace, each get one foisted READ on the session's first loop.
    // Global policy stays in the system prompt; nothing else is force-read.
    static async guidanceStatements(db: Db, workspaceId: number, sessionName: string): Promise<Array<FindStatement | ReadStatement>> {
        const statements: Array<FindStatement | ReadStatement> = [];
        for (const name of ["/AGENTS.md", "/AGENTS.local.md"]) {
            const pathname = generatedPathname(name);
            const entry = await db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: workspaceId, scheme: "workspace", authority: "", pathname,
            });
            if (entry === undefined) continue;
            const target: UrlPath = {
                kind: "url", raw: `workspace://${pathname}`, scheme: "workspace",
                username: null, password: null, hostname: null, port: null,
                pathname, query: null, fragment: null,
            };
            statements.push({
                op: "READ", aside: null, target,
                metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION,
            } satisfies ReadStatement);
        }
        const sessionAgents = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "session", authority: sessionName, pathname: "/AGENTS.md",
        });
        if (sessionAgents !== undefined) {
            const target: UrlPath = {
                kind: "url", raw: `session://${sessionName}/AGENTS.md`, scheme: "session",
                username: null, password: null, hostname: sessionName, port: null,
                pathname: "/AGENTS.md", query: null, fragment: null,
            };
            statements.push({
                op: "READ", aside: null, target,
                metadata: null, lineMarker: null, matcher: null, body: null, position: UNKNOWN_POSITION,
            } satisfies ReadStatement);
        }
        return statements;
    }

    // {§session-initialization-entry}: execute the initialization program before the model boundary.
    static async run(args: {
        db: Db;
        schemes: SchemeRegistry;
        executors: () => ExecutorRegistry | undefined;
        capabilities: CapabilityResolver;
        dispatcher: Dispatcher;
        executeAdmittedTurn: AdmittedTurnExecutor["executeAdmittedTurn"];
        workspaceId: number;
        sessionId: number;
        loopId: number;
        sessionName: string;
        initializationTurn: TurnRow;
        initializationPolicies: CapabilityPolicy[];
        initializationStatements: Array<FindStatement | ReadStatement>;
        fit: ContextFit;
        signal: AbortSignal | undefined;
        onDispatch: ((logEntryId: number) => void) | undefined;
        onSettled: ((logEntryId: number) => void | Promise<void>) | undefined;
    }): Promise<void> {
        const {
            db, schemes, executors, capabilities, dispatcher, executeAdmittedTurn,
            workspaceId, sessionId, loopId, sessionName,
            initializationTurn, initializationPolicies, initializationStatements,
            fit, signal, onDispatch, onSettled,
        } = args;
        // {§session-initialization-entry}: `init` lets the model curate the opening surveys as one set.
        // {§operator-config-workspace-settings} — workspace filesItems replaces the env default.
        const { filesItems: workspaceMI } = await WorkspaceSettings.read(db, workspaceId);
        const filesItems = workspaceMI !== null ? normalizeFilesItems(workspaceMI) : readFilesItems();
        if (filesItems !== null) { // {§session-initialization-entry} — once per session
            initializationStatements.push(...await InitializationTurn.#catalogSurveys({
                db, schemes, executors, capabilities, workspaceId, sessionName, initializationPolicies, filesItems,
            }));
        }
        // {§session-initialization-entry} — the survey is an ordinary operation program: recorded as the
        // turn's ops source and executed through the same path as a model's program; it authors no reasoning.
        // {§turn-source-resources} — a `_plurnk` turn has receipts, never a fabricated assistant emission.
        // {§message-arrival} — the message reaches the model as an inbound SEND in the first
        // model turn; initialization does not READ it a second time.
        const admittedInitializationStatements: Array<FindStatement | ReadStatement> = [];
        for (const statement of initializationStatements) {
            if (!capabilities.allowsAcross(statement, workspaceId, initializationPolicies)) continue;
            // {§session-initialization-entry} — a survey that would select nothing is left out of the program,
            // except the session's own scratch survey (`session://<session>/*`), which always runs so the model
            // sees its session namespace even when empty.
            if (
                statement.op === "FIND"
                && !(statement.target?.kind === "url" && statement.target.scheme === "session")
                && !await dispatcher.selects(statement, {
                    workspaceId, sessionId, loopId, turnId: initializationTurn.id, origin: "_plurnk",
                })
            ) continue;
            admittedInitializationStatements.push(statement);
        }
        if (admittedInitializationStatements.length === 0) {
            // Nothing to survey (the preview off, no project guidance): the turn opens and completes empty.
            await Turn.complete(db, initializationTurn.id, 200);
            return;
        }
        // {§session-initialization-entry} — the example turn shows the NOTE practice the card teaches:
        // when the surveys run, one NOTE opens them and one closes them.
        const programStatements: Array<NoteStatement | FindStatement | ReadStatement> =
            admittedInitializationStatements.some((statement) => statement.op === "FIND")
                ? [INITIALIZATION_NOTE, ...admittedInitializationStatements, INITIALIZATION_CLOSING_NOTE]
                : admittedInitializationStatements;
        const program = TurnOps.renderInternal(programStatements);
        const admitted = PlurnkParser.parseStatements(program).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        if (admitted.length !== programStatements.length) {
            throw new Error("initialization program did not preserve every authored operation");
        }
        await Turn.recordSource(db, initializationTurn.id, "ops", program);
        const result = await executeAdmittedTurn({
            statements: admitted,
            source: null,
            emission: null,
            origin: "_plurnk",
            workspaceId,
            sessionId,
            loopId,
            turnId: initializationTurn.id,
            fromSequence: 1,
            failOnOperationError: true,
            fit,
            signal,
            onDispatch,
            onSettled,
        });
        if (result.status !== 200) {
            throw new Error(`initialization returned ${result.status}; expected 200`);
        }
    }

    // {§session-initialization-entry} — the opening surveys, each admitted only when
    // its scheme is registered for the workspace. A positive filesItems caps the
    // project rows.
    static async #catalogSurveys(args: {
        db: Db;
        schemes: SchemeRegistry;
        executors: () => ExecutorRegistry | undefined;
        capabilities: CapabilityResolver;
        workspaceId: number;
        sessionName: string;
        initializationPolicies: CapabilityPolicy[];
        filesItems: number;
    }): Promise<FindStatement[]> {
        const { db, schemes, executors, capabilities, workspaceId, sessionName, initializationPolicies, filesItems } = args;
        const catalogSchemes = await db.engine_scheme_catalog_summary.all<{ scheme: string; entries: number; shallow_items: number }>({ workspace_id: workspaceId });
        const fileItems = catalogSchemes.find(({ scheme }) => scheme === "file")?.shallow_items ?? 0;
        const fileCap = filesItems > 0 && fileItems > 0 ? Math.min(filesItems, fileItems) : null;
        const surveys: FindStatement[] = [
            {
                op: "FIND", aside: null,
                target: { kind: "url", raw: "skill://*/SKILL.md", scheme: "skill", username: null, password: null, hostname: "*", port: null, pathname: "/SKILL.md", query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: null,
                target: workspaceCatalogTarget("plurnk"),
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                // {§tools-resource-materialization} — enabled MCP runtimes
                // survey one row per server; each row's summary is
                // the server one-liner or its flagship invocation form, so the
                // discovery row itself orients. Servers named in
                // PLURNK_MCP_EXPANDED add a second survey of their complete
                // tool tree.
                op: "FIND", aside: null,
                target: workspaceCatalogTarget("tools"),
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            ...InitializationTurn.#toolExpansions(executors, capabilities, workspaceId, initializationPolicies),
            {
                // {§tools-resource-materialization} — enabled members definitions survey at alias
                // level; each row's summary is what its glob resolved to.
                op: "FIND", aside: null,
                target: { kind: "url", raw: "workspace:///_plurnk/members/*.md", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: generatedPathname("/members/*.md"), query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: "project root member files",
                target: { kind: "local", raw: "*" },
                metadata: null,
                matcher: null,
                body: null,
                lineMarker: fileCap === null ? null : { marks: [1, fileCap] },
                position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: "workspace knowledgebase entries",
                target: { kind: "url", raw: "workspace:///*", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/*", query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
            {
                op: "FIND", aside: "session knowledgebase entries",
                target: { kind: "url", raw: `session://${sessionName}/*`, scheme: "session", username: null, password: null, hostname: sessionName, port: null, pathname: "/*", query: null, fragment: null },
                metadata: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
        ];
        return surveys.filter(({ target }) =>
            schemes.get(target?.kind === "url" ? target.scheme : "file", workspaceId) !== undefined);
    }

    // {§tools-resource-materialization} — expanded runtimes project complete
    // invocation blocks, paged through ordinary FIND result ranges: one pattern FIND
    // per runtime, naming the admitted tools when the policy narrows them.
    static #toolExpansions(
        executors: () => ExecutorRegistry | undefined,
        capabilities: CapabilityResolver,
        workspaceId: number,
        policies: CapabilityPolicy[],
    ): FindStatement[] {
        const registry = executors();
        const expansions: FindStatement[] = [];
        for (const tag of registry?.availableRuntimes(workspaceId) ?? []) {
            const entry = registry?.entry(tag, workspaceId);
            if (entry?.resourcesPath !== "/tools" || entry.expandTools !== true) continue;
            const tools = registry?.toolRegistry(tag, workspaceId);
            const admittedTools = tools?.tools.filter((tool) =>
                capabilities.allowsRuntimeAcross(tag, tool.target, workspaceId, policies)) ?? [];
            if (admittedTools.length === 0) continue;
            const targetFilter = tools !== null && tools !== undefined && admittedTools.length !== tools.tools.length
                ? " \\((?:" + admittedTools.map((tool) => regexLiteral(PathSyntax.escapeTarget(tool.target))).join("|") + ")\\)"
                : " ";
            const pattern = "^(\x60{3,})" + regexLiteral(tag) + targetFilter + "[^\\n]*?(?:\\1|\\n[\\s\\S]*?\\n\\1)$";
            expansions.push({
                op: "FIND", aside: null,
                target: { kind: "url", raw: `workspace:///_plurnk/tools/${tag}.md`, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: generatedPathname(`/tools/${tag}.md`), query: null, fragment: null },
                metadata: null,
                matcher: { dialect: "regex", raw: `/${pattern.replaceAll("/", "\\/")}/m`, pattern, flags: "m" },
                body: null, lineMarker: null, position: UNKNOWN_POSITION,
            });
        }
        return expansions;
    }
}

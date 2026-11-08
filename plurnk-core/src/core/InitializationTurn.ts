import { PlurnkParser } from "@plurnk/plurnk-parser";
import {
    UNKNOWN_POSITION, isExecution,
    type CapabilityPolicy, type ExecStatement, type FindStatement, type ReadStatement, type TodoStatement,
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
import EffectPolicy from "../schemes/EffectPolicy.ts";

// PLURNK_SERVICE_FILES_ITEMS — the turn-0 catalog preview. null = off;
// -1 = the ordinary markerless page; positive N explicitly caps file rows. 0 / unset = off.
const normalizeFilesItems = (n: number): number | null => (!Number.isFinite(n) || n === 0 ? null : n < 0 ? -1 : n);
const readFilesItems = (): number | null => {
    const raw = process.env.PLURNK_SERVICE_FILES_ITEMS;
    if (raw === undefined || raw.length === 0) return null;
    return normalizeFilesItems(Number.parseInt(raw, 10));
};

// {§session-initialization-entry} — the closing TODO after the initialization surveys.
const INITIALIZATION_CLOSING_TODO: TodoStatement = {
    op: "todo", aside: "<<<EOF ... EOF multiline string", target: null, lineMarker: null,
    body: "Resolve all Open Work.", position: UNKNOWN_POSITION,
};

export default class InitializationTurn {
    // {§session-initialization-entry} — the session's first turn is the worked
    // example itself: the actual orienting operations.
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
        loopSequence: number;
        sessionName: string;
        initializationTurn: TurnRow;
        initializationPolicies: CapabilityPolicy[];
        initializationStatements: ReadonlyArray<FindStatement | ReadStatement | ExecStatement>;
        fit: ContextFit;
        signal: AbortSignal | undefined;
        onDispatch: ((logEntryId: number) => void) | undefined;
        onSettled: ((logEntryId: number) => void | Promise<void>) | undefined;
    }): Promise<void> {
        const {
            db, schemes, executors, capabilities, dispatcher, executeAdmittedTurn,
            workspaceId, sessionId, loopId, loopSequence, sessionName,
            initializationTurn, initializationPolicies, initializationStatements,
            fit, signal, onDispatch, onSettled,
        } = args;
        const surveyStatements: Array<FindStatement | ReadStatement | ExecStatement> = [...initializationStatements];
        // {§session-initialization-entry}: `init` lets the model curate the opening surveys as one set.
        // {§operator-config-workspace-settings} — workspace filesItems replaces the env default.
        const { filesItems: workspaceMI } = await WorkspaceSettings.read(db, workspaceId);
        const filesItems = workspaceMI !== null ? normalizeFilesItems(workspaceMI) : readFilesItems();
        if (filesItems !== null) { // {§session-initialization-entry} — once per session
            surveyStatements.push(...await InitializationTurn.#catalogSurveys({
                db, schemes, capabilities, workspaceId, sessionName, initializationPolicies, filesItems,
            }));
        }
        // {§session-initialization-entry} — the survey is an ordinary operation program: recorded as the
        // turn's ops source and executed through the same path as a model's program; it authors no reasoning.
        // {§turn-source-resources} — the initialization turn records its canonical program as turn 1's emission.
        // {§message-arrival} — the message reaches the model as an inbound SEND in the first
        // model turn; initialization does not READ it a second time.
        const admittedInitializationStatements: Array<FindStatement | ReadStatement | ExecStatement> = [];
        for (const statement of surveyStatements) {
            if (!capabilities.allowsAcross(statement, workspaceId, initializationPolicies)) continue;
            // {§session-initialization-entry} — a survey that would select nothing is left out of the program,
            // except the session's own scratch survey (`session://<session>/*`), which always runs so the model
            // sees its session namespace even when empty.
            if (
                statement.op === "find"
                && !(statement.target?.kind === "url" && statement.target.scheme === "session")
                && !await dispatcher.selects(statement, {
                    workspaceId, sessionId, loopId, turnId: initializationTurn.id, origin: "_plurnk",
                })
            ) continue;
            if (
                statement.op === "read"
                && !await dispatcher.selects({
                    op: "find",
                    aside: null,
                    target: statement.target,
                    headers: null,
                    matcher: null,
                    body: null,
                    lineMarker: { marks: [1, -1] },
                    position: UNKNOWN_POSITION,
                }, {
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
        // {§session-initialization-entry} — the example turn shows the todo practice the card teaches:
        // when the surveys run, one todo closes them.
        const programStatements: Array<TodoStatement | FindStatement | ReadStatement | ExecStatement> =
            admittedInitializationStatements.some((statement) => statement.op === "find" || statement.op === "read" || isExecution(statement))
                ? [...admittedInitializationStatements, INITIALIZATION_CLOSING_TODO]
                : admittedInitializationStatements;
        const program = TurnOps.renderInternal(programStatements);
        const admitted = PlurnkParser.parseStatements(program, {
            executors: executors()?.availableRuntimes(workspaceId) ?? [],
        }).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        if (admitted.length !== programStatements.length) {
            throw new Error("initialization program did not preserve every authored operation");
        }
        const result = await executeAdmittedTurn({
            statements: admitted,
            source: program,
            emission: {
                content: program,
                statements: admitted,
                sessionName,
                loopSeq: loopSequence,
                turnSeq: initializationTurn.sequence,
            },
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
        capabilities: CapabilityResolver;
        workspaceId: number;
        sessionName: string;
        initializationPolicies: CapabilityPolicy[];
        filesItems: number;
    }): Promise<Array<FindStatement | ReadStatement>> {
        const { db, schemes, capabilities, workspaceId, sessionName, initializationPolicies, filesItems } = args;
        const catalogSchemes = await db.engine_scheme_catalog_summary.all<{ scheme: string; entries: number; shallow_items: number }>({ workspace_id: workspaceId });
        const fileItems = catalogSchemes.find(({ scheme }) => scheme === "file")?.shallow_items ?? 0;
        const mcpEntries = catalogSchemes.find(({ scheme }) => scheme === "mcp")?.entries ?? 0;
        const fileCap = filesItems > 0 && fileItems > 0 ? Math.min(filesItems, fileItems) : null;
        const canAutoRead = (): boolean => {
            try {
                return EffectPolicy.decide("read") === "auto";
            } catch {
                return false;
            }
        };
        const surveys: Array<FindStatement | ReadStatement> = [
            {
                op: "find", aside: null,
                target: { kind: "url", raw: "skill://*/SKILL.md", scheme: "skill", username: null, password: null, hostname: "*", port: null, pathname: "/SKILL.md", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "find", aside: "Plurnk",
                target: { kind: "url", raw: "skill://plurnk/*.md", scheme: "skill", username: null, password: null, hostname: "plurnk", port: null, pathname: "/*.md", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
            {
                op: "find", aside: null,
                target: { kind: "url", raw: "persona://*/PERSONA.md", scheme: "persona", username: null, password: null, hostname: "*", port: null, pathname: "/PERSONA.md", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "find", aside: null,
                target: { kind: "url", raw: "mcp:///*.md", scheme: "mcp", username: null, password: null, hostname: null, port: null, pathname: "/*.md", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "read", aside: null,
                target: { kind: "url", raw: "mcp:///plurnk.md", scheme: "mcp", username: null, password: null, hostname: null, port: null, pathname: "/plurnk.md", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: { marks: [1, -1] }, position: UNKNOWN_POSITION,
            },
            {
                op: "read", aside: "Use mcp:///<server>.json or mcp:///<server>/<tool>.json for tool schemas.",
                target: { kind: "url", raw: "mcp:///plurnk/edit.json", scheme: "mcp", username: null, password: null, hostname: null, port: null, pathname: "/plurnk/edit.json", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
            {
                op: "find", aside: "project root member files",
                target: { kind: "local", raw: "*" },
                headers: null,
                matcher: null,
                body: null,
                lineMarker: fileCap === null ? null : { marks: [1, fileCap] },
                position: UNKNOWN_POSITION,
            },
            {
                op: "find", aside: "workspace knowledgebase entries",
                target: { kind: "url", raw: "workspace:///*", scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/*", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
            {
                op: "find", aside: "session knowledgebase entries",
                target: { kind: "url", raw: `session://${sessionName}/*`, scheme: "session", username: null, password: null, hostname: sessionName, port: null, pathname: "/*", query: null, fragment: null },
                headers: null,
                matcher: null, body: null, lineMarker: null, position: UNKNOWN_POSITION,
            },
        ];
        return surveys.filter((statement) => {
            const scheme = statement.target?.kind === "url" ? statement.target.scheme : "file";
            if (statement.op === "read") {
                if (!canAutoRead()) return false;
                if (scheme === "mcp") {
                    if (statement.target?.kind === "url" && statement.target.pathname === "/plurnk/edit.json"
                        && !capabilities.allowsCoreOperationAcross("edit", workspaceId, initializationPolicies)) {
                        return false;
                    }
                    return mcpEntries > 0 && schemes.get("mcp", workspaceId) !== undefined;
                }
                return schemes.get(scheme, workspaceId) !== undefined;
            }
            if (scheme === "mcp") {
                return mcpEntries > 0 && schemes.get("mcp", workspaceId) !== undefined;
            }
            return schemes.get(scheme, workspaceId) !== undefined;
        });
    }
}

import {
    INTERNAL_ROW_OPS,
    PlurnkParseError,
    isExecutionOp,
    isRecord,
    type BareStatement,
    type CopyStatement,
    type DispositionStatement,
    type DoneStatement,
    type EditStatement,
    type ExecStatement,
    type FailStatement,
    type ForkStatement,
    type KillStatement,
    type MoveStatement,
    type NoteStatement,
    type ParseAttempt,
    type ParseItem,
    type PlurnkStatement,
    type Position,
    type ResourceSelection,
    type RuntimeTag,
    type SendStatement,
    type TodoStatement,
    type WorkStatement,
} from "@plurnk/plurnk-contracts";
import { BUILTIN_STANDALONE_EXECUTORS, propAccess } from "./CodeSerializer.ts";
import { hasHeredocKey, toStringValue } from "./HeredocSyntax.ts";
import {
    BUILTIN_EXEC_KEYS,
    CALL_OPTIONS_KEYS,
    CONCLUSION_KEYS,
    CORE_OP_MAP,
    DELEGATION_KEYS,
    EDIT_ITEM_KEYS,
    EDIT_KEYS,
    KILL_KEYS,
    NOTE_KEYS,
    PLURNK_RUNTIME_TOOLS,
    READ_FIND_KEYS,
    SEND_KEYS,
    TODO_KEYS,
    TRANSFER_KEYS,
    WAIT_KEYS,
    assertAllowedKeys,
    attemptVerbOf,
    buildExecutorSpellings,
    isBareScriptFilename,
    isCallerTargetAlias,
    isConclusionCallerAlias,
    oldTextToMatcher,
    parseSelectionInput,
    toAttachments,
    toHeaders,
    toLineMarker,
    toMatcherBody,
    toRemote,
    toSendBody,
    toTextLineMarker,
    type CodeModeOptions,
    type ParsedCall,
} from "./OptionCoercion.ts";
import { parsePath, targetMembers } from "./TargetSyntax.ts";

export { attemptVerbOf, buildExecutorSpellings, type CodeModeOptions, type ParsedCall };

export interface CallDispatcher {
    readonly executorSpellings: ReadonlyMap<string, RuntimeTag>;
    readonly lowerCalls: (
        produceCalls: () => readonly ParsedCall[],
        chunkPosition: Position,
        defaultAside: string | null,
        attempt: ParseAttempt,
    ) => ParseItem[];
}

export const createCallDispatcher = (options: CodeModeOptions = {}): CallDispatcher => {
    const hasExplicitExecutors = options.executors !== undefined;
    const executorSpellings = buildExecutorSpellings(options.executors);

    let activePosition: Position = { line: 1, column: 0 };
    let activeDefaultAside: string | null = null;
    let activeChunkStatements: PlurnkStatement[] = [];

    const emitStatement = <T extends PlurnkStatement>(statement: T): T => {
        const withAside: T = statement.aside === null && activeDefaultAside !== null
            ? { ...statement, aside: activeDefaultAside }
            : statement;
        activeChunkStatements.push(withAside);
        return withAside;
    };

    const resolveAside = (argObj: Record<string, unknown> | null): string | null => {
        if (argObj !== null && typeof argObj.aside === "string" && argObj.aside.trim().length > 0) {
            return argObj.aside.trim();
        }
        return activeDefaultAside;
    };

    const buildReadOrFind = (op: "read" | "find", args: readonly unknown[]): PlurnkStatement | PlurnkStatement[] => {
        const pos = activePosition;
        const recovery = op === "read"
            ? 'plurnk.read({ path: "path/to/file" })'
            : 'plurnk.find({ path: "**", pattern: "/needle/" })';
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null))) {
            if (op === "read") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
            }
            return emitStatement({
                op: "find",
                aside: activeDefaultAside,
                target: null,
                lineMarker: null,
                matcher: null,
                headers: null,
                body: null,
                position: pos,
            });
        }
        const first = args[0];
        if (Array.isArray(first)) {
            if (first.length === 0 && op === "read") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
            }
            const results: PlurnkStatement[] = [];
            for (const entry of first) {
                const sub = buildReadOrFind(op, [entry]);
                if (Array.isArray(sub)) results.push(...sub);
                else results.push(sub);
            }
            return results;
        }
        if (typeof first === "string") {
            const parsed = parsePath(first, pos);
            if (parsed === null && op === "read") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
            }
            const targets = parsed === null ? [null] : targetMembers(parsed);
            const second = isRecord(args[1]) ? args[1] : null;
            if (second !== null) {
                assertAllowedKeys(second, READ_FIND_KEYS, `plurnk.${op}`, recovery, pos);
            }
            if (typeof second?.note === "string" && second.note.trim().length > 0) {
                emitStatement({ op: "note", aside: null, target: null, lineMarker: null, body: second.note, position: pos });
            }
            const aside = resolveAside(second);
            const matcher = toMatcherBody(second?.pattern ?? second?.matcher ?? second?.query, op, pos, hasHeredocKey(second, "pattern", "matcher", "query"));
            const headers = toHeaders(second?.headers, pos);
            return targets.map((target) => emitStatement(op === "read" ? {
                op: "read",
                aside,
                target,
                lineMarker: toTextLineMarker(second?.range ?? second?.lines ?? second?.scope, pos),
                matcher,
                headers,
                body: null,
                position: pos,
            } : {
                op: "find",
                aside,
                target,
                lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope ?? second?.limit, pos, true),
                matcher,
                headers,
                body: null,
                position: pos,
            }));
        }
        if (isRecord(first)) {
            assertAllowedKeys(first, READ_FIND_KEYS, `plurnk.${op}`, recovery, pos);
            if (typeof first.note === "string" && first.note.trim().length > 0) {
                emitStatement({ op: "note", aside: null, target: null, lineMarker: null, body: first.note, position: pos });
            }
            const aside = resolveAside(first);
            const headers = toHeaders(first.headers, pos);
            const baseRawPaths = first.paths ?? first.targets ?? first.resources ?? first.path ?? first.target ?? first.uri ?? first.resource ?? first.file_path ?? first.filePath ?? first.filepath ?? first.file;
            const patternCandidate = first.pattern ?? first.matcher ?? first.query;
            const patternAsPath = baseRawPaths === undefined
                && typeof patternCandidate === "string"
                && !hasHeredocKey(first, "pattern", "matcher", "query")
                && /^(?:workspace|file|log|session|skill|mcp|ops|reasoning|message):\/\//u.test(patternCandidate.trim());
            const rawPaths = patternAsPath ? patternCandidate.trim() : baseRawPaths;
            const matcher = patternAsPath ? null : toMatcherBody(patternCandidate, op, pos, hasHeredocKey(first, "pattern", "matcher", "query"));
            if (Array.isArray(rawPaths)) {
                if (rawPaths.length === 0 && op === "read") {
                    throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
                }
                const results: PlurnkStatement[] = [];
                for (const item of rawPaths) {
                    if (typeof item === "string") {
                        const parsed = parsePath(item, pos);
                        const members = parsed === null ? [null] : targetMembers(parsed);
                        for (const target of members) {
                            results.push(emitStatement(op === "read" ? {
                                op: "read",
                                aside,
                                target,
                                lineMarker: toTextLineMarker(first.range ?? first.lines ?? first.scope, pos),
                                matcher,
                                headers,
                                body: null,
                                position: pos,
                            } : {
                                op: "find",
                                aside,
                                target,
                                lineMarker: toLineMarker(first.range ?? first.lines ?? first.scope ?? first.limit, pos, true),
                                matcher,
                                headers,
                                body: null,
                                position: pos,
                            }));
                        }
                    } else if (isRecord(item)) {
                        const sub = buildReadOrFind(op, [{ ...first, ...item, paths: undefined, targets: undefined, note: undefined }]);
                        if (Array.isArray(sub)) results.push(...sub);
                        else results.push(sub);
                    }
                }
                return results;
            }
            if (rawPaths !== undefined && rawPaths !== null && typeof rawPaths !== "string") {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} path must be a string`, "error");
            }
            const parsed = typeof rawPaths === "string" ? parsePath(rawPaths, pos) : null;
            if (parsed === null && op === "read") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
            }
            const targets = parsed === null ? [null] : targetMembers(parsed);
            return targets.map((target) => emitStatement(op === "read" ? {
                op: "read",
                aside,
                target,
                lineMarker: toTextLineMarker(first.range ?? first.lines ?? first.scope, pos),
                matcher,
                headers,
                body: null,
                position: pos,
            } : {
                op: "find",
                aside,
                target,
                lineMarker: toLineMarker(first.range ?? first.lines ?? first.scope ?? first.limit, pos, true),
                matcher,
                headers,
                body: null,
                position: pos,
            }));
        }
        throw new PlurnkParseError(pos.line, pos.column, "parser", `Invalid arguments to plurnk.${op}.`, "error");
    };

    const buildEdit = (args: readonly unknown[]): EditStatement | EditStatement[] => {
        const pos = activePosition;
        const recovery = 'plurnk.edit({ path: "path/to/file", text: "..." })';
        const first = args[0];
        if (typeof first === "string" && args.length >= 2) {
            const parsed = parsePath(first, pos);
            if (parsed === null) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires a target.", "error", recovery);
            }
            const body = args[1] === null || args[1] === undefined || args[1] === "" ? null : toStringValue(args[1]);
            return targetMembers(parsed).map((target) => emitStatement({
                op: "edit",
                aside: activeDefaultAside,
                target,
                lineMarker: null,
                matcher: null,
                headers: null,
                body,
                position: pos,
            }));
        }
        if (!isRecord(first)) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires an options object with `path`.", "error", recovery);
        }
        assertAllowedKeys(first, EDIT_KEYS, "plurnk.edit", recovery, pos);
        const rawPath = first.path ?? first.target ?? first.uri ?? first.resource ?? first.file_path ?? first.filePath ?? first.filepath ?? first.file;
        if (typeof rawPath !== "string" || rawPath.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires a target.", "error", recovery);
        }
        const parsed = parsePath(rawPath, pos);
        if (parsed === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires a target.", "error", recovery);
        }
        const targets = targetMembers(parsed);
        const aside = resolveAside(first);
        const headers = toHeaders(first.headers, pos);

        if (Array.isArray(first.edits)) {
            if (first.edits.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", "edit `edits` array cannot be empty.", "error");
            }
            const statements: EditStatement[] = [];
            for (const target of targets) {
                for (const item of first.edits) {
                    if (!isRecord(item)) {
                        throw new PlurnkParseError(pos.line, pos.column, "visitor", "Each entry in `edits` must be an object.", "error");
                    }
                    assertAllowedKeys(item, EDIT_ITEM_KEYS, "plurnk.edit.edits", recovery, pos);
                    const itemLineMarker = toTextLineMarker(item.range ?? item.lines ?? item.scope ?? first.range ?? first.lines ?? first.scope, pos);
                    const rawItemOld = item.oldText ?? item.old_string ?? item.old_text;
                    const itemMatcher = typeof rawItemOld === "string"
                        ? oldTextToMatcher(rawItemOld, pos)
                        : toMatcherBody(item.pattern ?? item.matcher, "edit", pos, hasHeredocKey(item, "pattern", "matcher"));
                    const rawContent = item.text ?? item.newText ?? item.new_string ?? item.new_text ?? item.replacement ?? item.content ?? item.body;
                    const body = rawContent === undefined || rawContent === null || rawContent === "" ? null : toStringValue(rawContent);
                    statements.push(emitStatement({
                        op: "edit",
                        aside,
                        target,
                        lineMarker: itemLineMarker,
                        matcher: itemMatcher,
                        headers,
                        body,
                        position: pos,
                    }));
                }
            }
            return statements;
        }

        const lineMarker = toTextLineMarker(first.range ?? first.lines ?? first.scope, pos);
        const rawOld = first.oldText ?? first.old_string ?? first.old_text;
        const matcher = typeof rawOld === "string"
            ? oldTextToMatcher(rawOld, pos)
            : toMatcherBody(first.pattern ?? first.matcher, "edit", pos, hasHeredocKey(first, "pattern", "matcher"));
        const rawBody = first.text ?? first.newText ?? first.new_string ?? first.new_text ?? first.replacement ?? first.content ?? first.body;
        const body = rawBody === undefined || rawBody === null || rawBody === "" ? null : toStringValue(rawBody);
        return targets.map((target) => emitStatement({
            op: "edit",
            aside,
            target,
            lineMarker,
            matcher,
            headers,
            body,
            position: pos,
        }));
    };

    const buildTransfer = (op: "copy" | "move", args: readonly unknown[]): CopyStatement | MoveStatement => {
        const pos = activePosition;
        const recovery = `plurnk.${op}({ from: "source", to: "destination" })`;
        if (typeof args[0] === "string" && typeof args[1] === "string") {
            const source = parseSelectionInput(args[0], op, "from", pos);
            const destination = parseSelectionInput(args[1], op, "to", pos);
            return emitStatement({ op, aside: activeDefaultAside, source, destination, position: pos });
        }
        const first = args[0];
        if (!isRecord(first)) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires both from and to targets.`, "error", recovery);
        }
        assertAllowedKeys(first, TRANSFER_KEYS, `plurnk.${op}`, recovery, pos);
        const rawFrom = first.from ?? first.source ?? first.src;
        const rawTo = first.to ?? first.destination ?? first.dest;
        const sourceBase = parseSelectionInput(rawFrom, op, "from", pos);
        const destBase = parseSelectionInput(rawTo, op, "to", pos);
        const source: ResourceSelection = {
            target: sourceBase.target,
            lineMarker: sourceBase.lineMarker ?? toTextLineMarker(first.range ?? first.lines ?? first.scope ?? first.sourceRange ?? first.fromRange, pos),
            matcher: sourceBase.matcher ?? toMatcherBody(first.pattern ?? first.matcher ?? first.sourcePattern ?? first.fromPattern, op, pos, hasHeredocKey(first, "pattern", "matcher", "sourcePattern", "fromPattern")),
            headers: sourceBase.headers ?? toHeaders(first.headers ?? first.sourceHeaders ?? first.fromHeaders, pos),
        };
        const destination: ResourceSelection = {
            target: destBase.target,
            lineMarker: destBase.lineMarker ?? toTextLineMarker(first.toRange ?? first.destinationRange ?? first.destRange, pos),
            matcher: destBase.matcher ?? toMatcherBody(first.toPattern ?? first.destinationPattern, op, pos, hasHeredocKey(first, "toPattern", "destinationPattern")),
            headers: destBase.headers ?? toHeaders(first.toHeaders ?? first.destinationHeaders, pos),
        };
        return emitStatement({
            op,
            aside: resolveAside(first),
            source,
            destination,
            position: pos,
        });
    };

    const buildKill = (args: readonly unknown[]): KillStatement | KillStatement[] => {
        const pos = activePosition;
        const recovery = 'plurnk.kill({ path: "log:///1/1/1/read" })';
        const first = args[0];
        if (Array.isArray(first)) {
            if (first.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
            }
            const results: KillStatement[] = [];
            for (const item of first) {
                const sub = buildKill([item]);
                if (Array.isArray(sub)) results.push(...sub);
                else results.push(sub);
            }
            return results;
        }
        if (typeof first === "string") {
            const parsed = parsePath(first, pos);
            if (parsed === null) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
            }
            const second = isRecord(args[1]) ? args[1] : null;
            if (second !== null) {
                assertAllowedKeys(second, KILL_KEYS, "plurnk.kill", recovery, pos);
            }
            const rawNote = typeof args[1] === "string" ? args[1] : (second?.note ?? second?.distillation ?? second?.body ?? second?.content ?? second?.text);
            const note = typeof rawNote === "string" && rawNote.trim().length > 0 ? rawNote : null;
            const lineMarker = toTextLineMarker(second?.range ?? second?.lines ?? second?.scope, pos);
            const matcher = toMatcherBody(second?.pattern ?? second?.matcher, "kill", pos, hasHeredocKey(second, "pattern", "matcher"));
            const remote = toRemote(second?.remote, pos);
            const headers = toHeaders(second?.headers, pos);
            const aside = resolveAside(second);
            return targetMembers(parsed).map((target, idx) => emitStatement({
                op: "kill",
                aside,
                target,
                lineMarker,
                matcher,
                remote,
                headers,
                body: idx === 0 ? note : null,
                position: pos,
            }));
        }
        if (isRecord(first)) {
            assertAllowedKeys(first, KILL_KEYS, "plurnk.kill", recovery, pos);
            const baseRawPaths = first.paths ?? first.targets ?? first.resources ?? first.path ?? first.target ?? first.uri ?? first.resource ?? first.file_path ?? first.filePath ?? first.filepath ?? first.file;
            const patternCandidate = first.pattern ?? first.matcher;
            const patternAsPath = baseRawPaths === undefined
                && typeof patternCandidate === "string"
                && !hasHeredocKey(first, "pattern", "matcher")
                && /^(?:workspace|file|log|session|skill|mcp|ops|reasoning|message):\/\//u.test(patternCandidate.trim());
            const rawPaths = patternAsPath ? patternCandidate.trim() : baseRawPaths;
            const aside = resolveAside(first);
            const rawNote = first.note ?? first.distillation ?? first.body ?? first.content ?? first.text;
            const note = typeof rawNote === "string" && rawNote.trim().length > 0 ? rawNote : null;
            const lineMarker = toTextLineMarker(first.range ?? first.lines ?? first.scope, pos);
            const matcher = patternAsPath ? null : toMatcherBody(patternCandidate, "kill", pos, hasHeredocKey(first, "pattern", "matcher"));
            const remote = toRemote(first.remote, pos);
            const headers = toHeaders(first.headers, pos);

            if (Array.isArray(rawPaths)) {
                if (rawPaths.length === 0) {
                    throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
                }
                const results: KillStatement[] = [];
                for (const [idx, item] of rawPaths.entries()) {
                    if (typeof item === "string") {
                        const parsed = parsePath(item, pos);
                        if (parsed === null) {
                            throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error");
                        }
                        for (const [mIdx, target] of targetMembers(parsed).entries()) {
                            results.push(emitStatement({
                                op: "kill",
                                aside,
                                target,
                                lineMarker,
                                matcher,
                                remote,
                                headers,
                                body: idx === 0 && mIdx === 0 ? note : null,
                                position: pos,
                            }));
                        }
                    } else if (isRecord(item)) {
                        const sub = buildKill([{ ...first, ...item, paths: undefined, targets: undefined, note: idx === 0 ? note : null }]);
                        if (Array.isArray(sub)) results.push(...sub);
                        else results.push(sub);
                    }
                }
                return results;
            }
            if (typeof rawPaths !== "string" || rawPaths.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
            }
            const parsed = parsePath(rawPaths, pos);
            if (parsed === null) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
            }
            return targetMembers(parsed).map((target, idx) => emitStatement({
                op: "kill",
                aside,
                target,
                lineMarker,
                matcher,
                remote,
                headers,
                body: idx === 0 ? note : null,
                position: pos,
            }));
        }
        throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
    };

    const buildNote = (args: readonly unknown[]): NoteStatement => {
        const pos = activePosition;
        const first = args[0];
        if (first === undefined || first === null || first === "") {
            return emitStatement({ op: "note", aside: activeDefaultAside, target: null, lineMarker: null, body: null, position: pos });
        }
        if (typeof first === "string") {
            return emitStatement({ op: "note", aside: activeDefaultAside, target: null, lineMarker: null, body: first, position: pos });
        }
        if (isRecord(first)) {
            assertAllowedKeys(first, NOTE_KEYS, "plurnk.note", 'plurnk.note({ text: "..." })', pos);
            const rawPrimary = first.text ?? first.content ?? first.body ?? first.note ?? first.message;
            let body: string | null = null;
            if (rawPrimary !== undefined && rawPrimary !== null && rawPrimary !== "") {
                body = toStringValue(rawPrimary);
            } else {
                const extraParts = [
                    first.title,
                    first.fact,
                    first.facts,
                    first.decision,
                    first.decisions,
                    first.hypothesis,
                    first.hypotheses,
                    first.observation,
                    first.observations,
                    first.finding,
                    first.findings,
                    first.summary,
                ]
                    .filter((v) => v !== undefined && v !== null && v !== "")
                    .map((v) => toStringValue(v));
                if (extraParts.length > 0) {
                    body = extraParts.join("\n");
                }
            }
            return emitStatement({ op: "note", aside: resolveAside(first), target: null, lineMarker: null, body, position: pos });
        }
        return emitStatement({ op: "note", aside: activeDefaultAside, target: null, lineMarker: null, body: toStringValue(first), position: pos });
    };

    const formatTodoItem = (item: unknown): string => {
        if (typeof item === "string") {
            return item;
        }
        if (isRecord(item)) {
            const text = toStringValue(item.text ?? item.content ?? item.title ?? item.task ?? item.item ?? item.description ?? item.name ?? "");
            const status = item.status ?? (item.completed === true || item.done === true ? "done" : "pending");
            const box = status === "done" || status === "completed" || status === "x"
                ? "[x]"
                : status === "in_progress" || status === "active" || status === "~"
                    ? "[~]"
                    : "[ ]";
            return `- ${box} ${text}`;
        }
        return toStringValue(item);
    };

    const buildTodo = (args: readonly unknown[]): TodoStatement => {
        const pos = activePosition;
        const first = args[0];
        if (first === undefined || first === null || first === "") {
            return emitStatement({ op: "todo", aside: activeDefaultAside, target: null, lineMarker: null, body: null, position: pos });
        }
        if (typeof first === "string") {
            return emitStatement({ op: "todo", aside: activeDefaultAside, target: null, lineMarker: null, body: first, position: pos });
        }
        if (Array.isArray(first)) {
            const body = first.length === 0 ? null : first.map(formatTodoItem).join("\n");
            return emitStatement({ op: "todo", aside: activeDefaultAside, target: null, lineMarker: null, body, position: pos });
        }
        if (isRecord(first)) {
            assertAllowedKeys(first, TODO_KEYS, "plurnk.todo", 'plurnk.todo({ items: ["..."] })', pos);
            if (typeof first.note === "string" && first.note.trim().length > 0) {
                emitStatement({ op: "note", aside: null, target: null, lineMarker: null, body: first.note, position: pos });
            }
            const rawItems = Array.isArray(first.items) ? first.items : (Array.isArray(first.todos) ? first.todos : null);
            if (rawItems !== null) {
                const formatted = rawItems
                    .map(formatTodoItem)
                    .filter((item) => item.trim().length > 0 && !/^- \[[ x~]\]$/u.test(item.trim()));
                const body = formatted.length === 0 ? null : formatted.join("\n");
                return emitStatement({ op: "todo", aside: resolveAside(first), target: null, lineMarker: null, body, position: pos });
            }
            const rawText = first.text ?? first.content ?? first.body;
            const body = rawText === undefined || rawText === null || rawText === "" ? null : toStringValue(rawText);
            return emitStatement({ op: "todo", aside: resolveAside(first), target: null, lineMarker: null, body, position: pos });
        }
        return emitStatement({ op: "todo", aside: activeDefaultAside, target: null, lineMarker: null, body: toStringValue(first), position: pos });
    };

    const buildDelegation = (op: "work" | "fork" | "bare", args: readonly unknown[]): WorkStatement | ForkStatement | BareStatement => {
        const pos = activePosition;
        const recovery = `plurnk.${op}({ text: "..." })`;
        if (typeof args[0] === "string" && typeof args[1] === "string") {
            const target = op === "bare" ? null : parsePath(args[0], pos);
            return emitStatement({ op, aside: activeDefaultAside, target, lineMarker: null, body: args[1], position: pos });
        }
        if (typeof args[0] === "string") {
            return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, body: args[0], position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            assertAllowedKeys(first, DELEGATION_KEYS, `plurnk.${op}`, recovery, pos);
            const rawTarget = op === "bare"
                ? undefined
                : (first.target ?? first.path ?? first.uri ?? first.resource ?? (typeof first.session === "string"
                    ? (first.session.includes("://") ? first.session : `session://${first.session}`)
                    : undefined));
            const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
            const rawPrompt = first.text ?? first.prompt ?? first.body ?? first.content ?? first.message;
            const body = rawPrompt === undefined || rawPrompt === null ? "" : toStringValue(rawPrompt);
            return emitStatement({ op, aside: resolveAside(first), target, lineMarker: null, body, position: pos });
        }
        return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, body: "", position: pos });
    };

    const buildSend = (args: readonly unknown[]): SendStatement => {
        const pos = activePosition;
        const recovery = 'plurnk.send({ target: "session://name", text: "..." })';
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
            return emitStatement({ op: "send", aside: activeDefaultAside, target: null, lineMarker: null, headers: null, attachments: null, body: null, position: pos });
        }
        if (typeof args[0] === "string" && args.length >= 2 && (typeof args[1] === "string" || isRecord(args[1]))) {
            const target = isCallerTargetAlias(args[0]) ? null : parsePath(args[0], pos);
            if (typeof args[1] === "string") {
                return emitStatement({ op: "send", aside: activeDefaultAside, target, lineMarker: null, headers: null, attachments: null, body: args[1].length === 0 ? null : toSendBody(args[1]), position: pos });
            }
            const second = args[1];
            assertAllowedKeys(second, SEND_KEYS, "plurnk.send", recovery, pos);
            const rawText = second.text ?? second.content ?? second.body ?? second.message;
            const body = second.json !== undefined
                ? { raw: JSON.stringify(second.json), json: second.json }
                : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(toStringValue(rawText)));
            return emitStatement({
                op: "send",
                aside: resolveAside(second),
                target,
                lineMarker: null,
                headers: toHeaders(second.headers, pos),
                attachments: toAttachments(second.attachments, pos),
                body,
                position: pos,
            });
        }
        if (typeof args[0] === "string") {
            return emitStatement({ op: "send", aside: activeDefaultAside, target: null, lineMarker: null, headers: null, attachments: null, body: toSendBody(args[0]), position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            assertAllowedKeys(first, SEND_KEYS, "plurnk.send", recovery, pos);
            const rawTarget = first.target ?? first.to ?? first.recipient ?? first.path ?? first.uri ?? first.resource ?? (typeof first.session === "string"
                ? (first.session.includes("://") ? first.session : `session://${first.session}`)
                : undefined);
            const target = typeof rawTarget === "string" && rawTarget.length > 0 && !isCallerTargetAlias(rawTarget)
                ? parsePath(rawTarget, pos)
                : null;
            const headers = toHeaders(first.headers, pos);
            const attachments = toAttachments(first.attachments, pos);
            const rawText = first.text ?? first.content ?? first.body ?? first.message;
            const body = first.json !== undefined
                ? { raw: JSON.stringify(first.json), json: first.json }
                : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(toStringValue(rawText)));
            return emitStatement({ op: "send", aside: resolveAside(first), target, lineMarker: null, headers, attachments, body, position: pos });
        }
        return emitStatement({ op: "send", aside: activeDefaultAside, target: null, lineMarker: null, headers: null, attachments: null, body: toSendBody(toStringValue(args[0])), position: pos });
    };

    const buildConclusion = (op: "done" | "fail", args: readonly unknown[]): DoneStatement | FailStatement => {
        const pos = activePosition;
        const recovery = `plurnk.${op}({ text: "..." })`;
        if (args.length === 0) {
            return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, attachments: null, body: null, position: pos });
        }
        if (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === "")) {
            return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, attachments: null, body: null, position: pos });
        }
        if (typeof args[0] === "string" && typeof args[1] === "string") {
            const target = isConclusionCallerAlias(args[0]) ? null : parsePath(args[0], pos);
            return emitStatement({ op, aside: activeDefaultAside, target, lineMarker: null, attachments: null, body: args[1].length === 0 ? null : toSendBody(args[1]), position: pos });
        }
        if (typeof args[0] === "string") {
            return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, attachments: null, body: toSendBody(args[0]), position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            assertAllowedKeys(first, CONCLUSION_KEYS, `plurnk.${op}`, recovery, pos);
            const rawTarget = first.target ?? first.to ?? first.recipient ?? first.path ?? first.uri ?? first.resource;
            const target = typeof rawTarget === "string" && rawTarget.length > 0 && !isConclusionCallerAlias(rawTarget)
                ? parsePath(rawTarget, pos)
                : null;
            const attachments = toAttachments(first.attachments, pos);
            const rawText = first.text ?? first.content ?? first.body ?? first.message ?? first.reason ?? first.summary;
            const body = first.json !== undefined
                ? { raw: JSON.stringify(first.json), json: first.json }
                : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(toStringValue(rawText)));
            return emitStatement({ op, aside: resolveAside(first), target, lineMarker: null, attachments, body, position: pos });
        }
        return emitStatement({ op, aside: activeDefaultAside, target: null, lineMarker: null, attachments: null, body: toSendBody(toStringValue(args[0])), position: pos });
    };

    const buildWait = (args: readonly unknown[]): DispositionStatement => {
        const pos = activePosition;
        const recovery = "plurnk.wait({ seconds: 30 })";
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
            return emitStatement({ op: "wait", aside: activeDefaultAside, target: null, lineMarker: null, seconds: null, body: null, position: pos });
        }
        if (typeof args[0] === "number") {
            const seconds = Number.isFinite(args[0]) && args[0] >= 0 ? args[0] : null;
            const textAside = typeof args[1] === "string" && args[1].length > 0 ? args[1] : null;
            return emitStatement({ op: "wait", aside: activeDefaultAside ?? textAside, target: null, lineMarker: null, seconds, body: null, position: pos });
        }
        if (typeof args[0] === "string") {
            const textAside = args[0].length > 0 ? args[0] : null;
            return emitStatement({ op: "wait", aside: activeDefaultAside ?? textAside, target: null, lineMarker: null, seconds: null, body: null, position: pos });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            assertAllowedKeys(first, WAIT_KEYS, "plurnk.wait", recovery, pos);
            const rawSeconds = first.seconds ?? first.duration;
            let seconds: number | null = null;
            const parsedSeconds = typeof rawSeconds === "number"
                ? rawSeconds
                : typeof rawSeconds === "string" && rawSeconds.trim().length > 0
                    ? Number(rawSeconds)
                    : Number.NaN;
            if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
                seconds = parsedSeconds;
            }
            const rawText = first.text ?? first.body ?? first.content ?? first.message ?? first.reason;
            const textAside = rawText === undefined || rawText === null || rawText === "" ? null : toStringValue(rawText);
            return emitStatement({ op: "wait", aside: resolveAside(first) ?? textAside, target: null, lineMarker: null, seconds, body: null, position: pos });
        }
        const textAside = toStringValue(args[0]);
        return emitStatement({ op: "wait", aside: activeDefaultAside ?? (textAside.length > 0 ? textAside : null), target: null, lineMarker: null, seconds: null, body: null, position: pos });
    };

    const normalizePlurnkToolObject = (toolName: string, input: Record<string, unknown>): Record<string, unknown> => {
        const keyMap: Record<string, string> = {};
        if (toolName === "members") {
            for (const k of ["paths", "files", "file", "glob", "name", "alias"]) keyMap[k] = "path";
        } else if (toolName === "question") {
            for (const k of ["message", "question", "prompt", "content", "body"]) keyMap[k] = "text";
            keyMap.choices = "options";
            keyMap.multiSelect = "multi";
            keyMap.is_multi_select = "multi";
            keyMap.requestedSchema = "schema";
        } else if (toolName === "env" || toolName === "mcp" || toolName === "personas" || toolName === "schedule" || toolName === "skills" || toolName === "fx") {
            for (const k of ["alias", "key", "server", "id"]) keyMap[k] = "name";
            if (toolName === "env") {
                keyMap.environment = "env";
            } else if (toolName === "personas") {
                keyMap.text = "body";
                keyMap.instructions = "body";
            } else if (toolName === "schedule") {
                keyMap.text = "prompt";
                keyMap.message = "prompt";
            } else if (toolName === "skills") {
                keyMap.path = "source";
                keyMap.file = "source";
                keyMap.dir = "source";
            }
        } else {
            return input;
        }
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(input)) {
            if (v === undefined) continue;
            const mapped = keyMap[k];
            if (mapped !== undefined && !Object.hasOwn(input, mapped) && !Object.hasOwn(out, mapped)) {
                out[mapped] = v;
            } else {
                out[k] = v;
            }
        }
        return out;
    };

    const buildPlurnkTool = (rawToolName: string, args: readonly unknown[]): ExecStatement => {
        const pos = activePosition;
        const toolName = rawToolName === "environment" ? "env" : rawToolName;
        const target = parsePath(toolName, pos);
        const first = args[0];
        const second = isRecord(args[1]) ? args[1] : null;
        if (second !== null) {
            assertAllowedKeys(second, CALL_OPTIONS_KEYS, `plurnk.${toolName}`, `plurnk${propAccess(toolName)}({ ... })`, pos);
        }
        let body: string | null = null;
        if (first !== undefined && first !== null && first !== "") {
            if (isRecord(first)) {
                body = JSON.stringify(normalizePlurnkToolObject(toolName, first));
            } else {
                body = typeof first === "string" ? first : JSON.stringify(first);
            }
        }
        return emitStatement({
            runtime: "plurnk",
            aside: resolveAside(second),
            target,
            lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope, pos),
            body,
            position: pos,
        });
    };

    const buildStandaloneExec = (runtime: RuntimeTag, args: readonly unknown[]): ExecStatement => {
        const pos = activePosition;
        const isBuiltinExec = BUILTIN_STANDALONE_EXECUTORS.has(runtime);
        const recovery = `plurnk.${runtime}({ text: "..." })`;
        if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
            return emitStatement({
                runtime,
                aside: activeDefaultAside,
                target: null,
                lineMarker: null,
                body: null,
                position: pos,
            });
        }
        if (typeof args[0] === "string" && args.length >= 2) {
            const target = parsePath(args[0], pos);
            const second = args[1];
            const body = second === null || second === undefined || second === "" ? null : (typeof second === "string" ? second : JSON.stringify(second));
            const third = isRecord(args[2]) ? args[2] : null;
            if (third !== null) {
                assertAllowedKeys(third, CALL_OPTIONS_KEYS, `plurnk.${runtime}`, recovery, pos);
            }
            return emitStatement({
                runtime,
                aside: resolveAside(third),
                target,
                lineMarker: toLineMarker(third?.range ?? third?.lines ?? third?.scope, pos),
                body,
                position: pos,
            });
        }
        if (typeof args[0] === "string") {
            return emitStatement({
                runtime,
                aside: activeDefaultAside,
                target: null,
                lineMarker: null,
                body: args[0],
                position: pos,
            });
        }
        if (isRecord(args[0])) {
            const first = args[0];
            if (isBuiltinExec) {
                assertAllowedKeys(first, BUILTIN_EXEC_KEYS, `plurnk.${runtime}`, recovery, pos);
            }
            const hasEnvelopeKey = Object.keys(first).some((k) => BUILTIN_EXEC_KEYS.has(k));
            if (!hasEnvelopeKey && !isBuiltinExec) {
                const second = isRecord(args[1]) ? args[1] : null;
                if (second !== null) {
                    assertAllowedKeys(second, CALL_OPTIONS_KEYS, `plurnk.${runtime}`, recovery, pos);
                }
                return emitStatement({
                    runtime,
                    aside: resolveAside(second),
                    target: null,
                    lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope, pos),
                    body: Object.keys(first).length === 0 ? null : JSON.stringify(first),
                    position: pos,
                });
            }
            const explicitBody = first.text ?? first.code ?? first.command ?? first.cmd ?? first.body ?? first.source ?? first.prompt;
            const inlineScriptBody = explicitBody === undefined
                && typeof first.script === "string"
                && /[\s;()"'|&<>]/u.test(first.script.trim())
                ? first.script
                : undefined;
            const explicitScript = (inlineScriptBody === undefined ? first.script : undefined) ?? first.target ?? first.path ?? first.file;
            const initialBody = explicitBody ?? inlineScriptBody;
            const promoteBodyToScript = explicitScript === undefined && isBareScriptFilename(runtime, initialBody);
            const rawScript = promoteBodyToScript ? initialBody : explicitScript;
            const rawCwd = first.cwd;
            const hasBothCwdAndScript = typeof rawCwd === "string" && rawCwd.length > 0
                && typeof rawScript === "string" && rawScript.length > 0;
            const rawTarget = hasBothCwdAndScript ? rawScript : (rawCwd ?? rawScript);
            const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
            const cwd = hasBothCwdAndScript ? rawCwd : undefined;
            const lineMarker = toLineMarker(first.range ?? first.lines ?? first.scope, pos);
            let body: string | null = null;
            const rawBody = promoteBodyToScript ? undefined : initialBody;
            if (rawBody !== undefined && rawBody !== null && rawBody !== "") {
                body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody);
            } else if (Array.isArray(first.args) && first.args.length > 0) {
                body = first.args.map((arg) => {
                    const str = toStringValue(arg);
                    return /[\s"']/u.test(str) ? JSON.stringify(str) : str;
                }).join(" ");
            } else if (typeof first.args === "string" && first.args.length > 0) {
                body = first.args;
            }
            return emitStatement({
                runtime,
                aside: resolveAside(first),
                target,
                ...(cwd === undefined ? {} : { cwd }),
                lineMarker,
                body,
                position: pos,
            });
        }
        return emitStatement({
            runtime,
            aside: activeDefaultAside,
            target: null,
            lineMarker: null,
            body: JSON.stringify(args[0]),
            position: pos,
        });
    };

    const buildMcpCall = (rawServer: string, rawTool: string, args: readonly unknown[]): ExecStatement => {
        const pos = activePosition;
        const lowerServer = rawServer.toLowerCase();
        if (!isExecutionOp(lowerServer)) {
            throw new PlurnkParseError(pos.line, pos.column, "parser",
                `Invalid MCP runtime name ${JSON.stringify(rawServer)}.`, "error");
        }
        if (rawServer !== lowerServer && !executorSpellings.has(lowerServer)) {
            throw new PlurnkParseError(pos.line, pos.column, "parser",
                `Unknown runtime ${JSON.stringify(rawServer)}; runtime names are lowercase.`, "error");
        }
        const runtime = lowerServer;
        const target = parsePath(rawTool, pos);
        const first = args[0];
        const second = isRecord(args[1]) ? args[1] : null;
        if (second !== null) {
            assertAllowedKeys(second, CALL_OPTIONS_KEYS, `${runtime}${propAccess(rawTool)}`, `${runtime}${propAccess(rawTool)}({ ... })`, pos);
        }
        let body: string | null = null;
        if (first !== undefined && first !== null && first !== "") {
            body = typeof first === "string" ? first : JSON.stringify(first);
        }
        return emitStatement({
            runtime,
            aside: resolveAside(second),
            target,
            lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.scope, pos),
            body,
            position: pos,
        });
    };

    const dispatchPlurnkTool = (prop: string, args: readonly unknown[]): void => {
        const lower = prop.toLowerCase();
        const explicitSingleExecutor = options.executors?.length === 1 && options.executors[0]?.toLowerCase() === lower;
        const coreOp = explicitSingleExecutor ? undefined : CORE_OP_MAP.get(lower);
        if (coreOp !== undefined) {
            switch (coreOp) {
                case "read":
                case "find":
                    buildReadOrFind(coreOp, args);
                    return;
                case "edit":
                    buildEdit(args);
                    return;
                case "copy":
                case "move":
                    buildTransfer(coreOp, args);
                    return;
                case "kill":
                    buildKill(args);
                    return;
                case "note":
                    buildNote(args);
                    return;
                case "todo":
                    buildTodo(args);
                    return;
                case "work":
                case "fork":
                case "bare":
                    buildDelegation(coreOp, args);
                    return;
                case "send":
                    buildSend(args);
                    return;
                case "done":
                case "fail":
                    buildConclusion(coreOp, args);
                    return;
                case "wait":
                    buildWait(args);
                    return;
            }
        }
        if (PLURNK_RUNTIME_TOOLS.has(lower) || (lower.includes("|") && lower.split("|").every((part) => PLURNK_RUNTIME_TOOLS.has(part)))) {
            buildPlurnkTool(lower, args);
            return;
        }
        if (lower === "plurnk") {
            if (typeof args[0] === "string" && args.length > 1) {
                buildPlurnkTool(args[0], args.slice(1));
                return;
            }
            if (isRecord(args[0])) {
                throw new PlurnkParseError(
                    activePosition.line,
                    activePosition.column,
                    "parser",
                    "Missing operation name on `plurnk`; write `plurnk.<op>({ ... })`.",
                    "error",
                    "Use a core operation (`plurnk.read`, `plurnk.edit`, `plurnk.note`, `plurnk.done`, ...).",
                );
            }
            buildStandaloneExec("plurnk", args);
            return;
        }
        const knownRuntime = executorSpellings.get(lower);
        if (knownRuntime !== undefined) {
            buildStandaloneExec(knownRuntime, args);
            return;
        }
        const explicitOnlyPlurnk = options.executors?.length === 1 && options.executors[0]?.toLowerCase() === "plurnk";
        if (explicitOnlyPlurnk && !INTERNAL_ROW_OPS.has(lower)) {
            buildPlurnkTool(prop, args);
            return;
        }
        if (isExecutionOp(prop) && args.length > 0) {
            buildStandaloneExec(prop, args);
            return;
        }
        throw new PlurnkParseError(
            activePosition.line,
            activePosition.column,
            "parser",
            `Unknown operation \`plurnk.${prop}\`.`,
            "error",
            "Use a core operation (`plurnk.read`, `plurnk.edit`, `plurnk.done`, ...) or an MCP tool (`<service>.<tool>(...)`).",
        );
    };

    const dispatchCall = (call: ParsedCall): void => {
        activePosition = call.position;
        const { chain, args } = call;
        if (chain.length === 1) {
            const head = chain[0];
            const lower = head.toLowerCase();
            if (lower === "plurnk") {
                if (typeof args[0] === "string" && args.length > 1) {
                    buildPlurnkTool(args[0], args.slice(1));
                    return;
                }
                buildStandaloneExec("plurnk", args);
                return;
            }
            const knownRuntime = executorSpellings.get(lower);
            if (knownRuntime !== undefined) {
                buildStandaloneExec(knownRuntime, args);
                return;
            }
            if (!hasExplicitExecutors && isExecutionOp(head)) {
                buildStandaloneExec(head, args);
                return;
            }
            throw new PlurnkParseError(
                call.position.line,
                call.position.column,
                "parser",
                `Unknown operation \`${head}\`.`,
                "error",
                "Write `plurnk.<op>({ ... })` or `<service>.<tool>({ ... })`.",
            );
        }
        if (chain.length === 2) {
            const [service = "", tool = ""] = chain;
            if (service === "plurnk") {
                dispatchPlurnkTool(tool, args);
                return;
            }
            buildMcpCall(service, tool, args);
            return;
        }
        if (chain.length === 3 && chain[0]?.toLowerCase() === "plurnk") {
            const [, service = "", tool = ""] = chain;
            buildMcpCall(service, tool, args);
            return;
        }
        throw new PlurnkParseError(
            call.position.line,
            call.position.column,
            "parser",
            `Invalid call target \`${chain.join(".")}\`.`,
            "error",
            "Write `<service>.<tool>({ ... })`.",
        );
    };

    const lowerCalls = (
        produceCalls: () => readonly ParsedCall[],
        chunkPosition: Position,
        defaultAside: string | null,
        attempt: ParseAttempt,
    ): ParseItem[] => {
        activePosition = chunkPosition;
        activeDefaultAside = defaultAside;
        activeChunkStatements = [];
        const items: ParseItem[] = [];
        try {
            const calls = produceCalls();
            for (const call of calls) {
                dispatchCall(call);
            }
            for (const stmt of activeChunkStatements) {
                items.push({ kind: "statement", statement: stmt });
            }
        } catch (err) {
            if (err instanceof PlurnkParseError) {
                const pos = err.line === 0 && err.column === 0 ? chunkPosition : { line: err.line, column: err.column };
                const normalized = new PlurnkParseError(
                    pos.line,
                    pos.column,
                    err.source,
                    err.message,
                    err.severity,
                    err.recovery,
                    err.operationOmitted,
                );
                items.push({ kind: "error", error: normalized, attempt });
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                items.push({
                    kind: "error",
                    error: new PlurnkParseError(
                        chunkPosition.line,
                        chunkPosition.column,
                        "parser",
                        `Code Mode syntax error: ${msg}`,
                        "error",
                        "Write valid Code Mode calls such as `plurnk.read({ path: \"file.txt\" })`.",
                    ),
                    attempt,
                });
            }
        }
        return items;
    };

    return {
        executorSpellings,
        lowerCalls,
    };
};

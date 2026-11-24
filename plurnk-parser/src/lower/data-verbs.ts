import {
    PlurnkParseError,
    isRecord,
    type CopyStatement,
    type EditStatement,
    type KillStatement,
    type MoveStatement,
    type PlurnkStatement,
    type ResourceSelection,
} from "@plurnk/plurnk-contracts";
import {
    EDIT_ITEM_KEYS,
    EDIT_KEYS,
    KILL_KEYS,
    READ_FIND_KEYS,
    TRANSFER_KEYS,
    oldTextToMatcher,
    parseSelectionInput,
    toHeaders,
    toLineMarker,
    toRemote,
    toTextLineMarker,
    withChannelFragment,
} from "../OptionCoercion.ts";
import { parsePath, targetMembers } from "../TargetSyntax.ts";
import type { LoweringContext } from "./context.ts";

export const buildReadOrFind = (
    ctx: LoweringContext,
    op: "read" | "find",
    args: readonly unknown[],
): PlurnkStatement | PlurnkStatement[] => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const { tier } = ctx;
    const recovery = op === "read"
        ? 'mcp({ server: "plurnk", tool: "read", arguments: { path: "path/to/file" } })'
        : 'mcp({ server: "plurnk", tool: "find", arguments: { path: "**", pattern: "/needle/" } })';
    if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null))) {
        if (op === "read") {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
        }
        return ctx.emitStatement({
            op: "find",
            aside: defaultAside,
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
            const sub = buildReadOrFind(ctx, op, [entry]);
            if (Array.isArray(sub)) results.push(...sub);
            else results.push(sub);
        }
        return results;
    }
    if (typeof first === "string") {
        const second = isRecord(args[1]) ? args[1] : null;
        if (second !== null) {
            ctx.checkKeys(second, READ_FIND_KEYS, `plurnk.${op}`, recovery, pos);
        }
        const parsed = parsePath(tier === "model" ? withChannelFragment(first, second?.channel) : first, pos);
        if (parsed === null && op === "read") {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
        }
        const targets = parsed === null ? [null] : targetMembers(parsed);
        if (typeof second?.note === "string" && second.note.trim().length > 0) {
            ctx.emitStatement({ op: "note", aside: null, target: null, lineMarker: null, body: second.note, position: pos });
        }
        const aside = ctx.resolveAside(second);
        const matcher = ctx.resolveMatcher(second?.pattern ?? second?.matcher ?? second?.query, op, pos);
        const headers = toHeaders(second?.headers, pos);
        return targets.map((target) => ctx.emitStatement(op === "read" ? {
            op: "read",
            aside,
            target,
            lineMarker: toTextLineMarker(second?.range ?? second?.lines ?? second?.line ?? second?.scope, pos),
            matcher,
            headers,
            body: null,
            position: pos,
        } : {
            op: "find",
            aside,
            target,
            lineMarker: toLineMarker(second?.range ?? second?.lines ?? second?.line ?? second?.scope ?? second?.limit, pos, true),
            matcher,
            headers,
            body: null,
            position: pos,
        }));
    }
    if (isRecord(first)) {
        ctx.checkKeys(first, READ_FIND_KEYS, `plurnk.${op}`, recovery, pos);
        if (typeof first.note === "string" && first.note.trim().length > 0) {
            ctx.emitStatement({ op: "note", aside: null, target: null, lineMarker: null, body: first.note, position: pos });
        }
        const aside = ctx.resolveAside(first);
        const headers = toHeaders(first.headers, pos);
        const fallbackId = tier === "model"
            && typeof first.id === "string"
            && first.id.trim().length > 0
            && (op === "read" || /^(?:[a-z][a-z0-9+._-]*:\/\/|.*[/.])/iu.test(first.id.trim()))
            ? first.id.trim()
            : undefined;
        const baseRawPaths = first.paths ?? first.targets ?? first.resources ?? first.path ?? first.target ?? first.uri ?? first.resource ?? first.file_path ?? first.filePath ?? first.filepath ?? first.file ?? fallbackId;
        const patternCandidate = first.pattern ?? first.matcher ?? first.query;
        const patternAsPath = baseRawPaths === undefined
            && typeof patternCandidate === "string"
            && /^(?:workspace|file|log|session|skill|mcp|ops|reasoning|message):\/\//u.test(patternCandidate.trim());
        const rawPaths = patternAsPath ? patternCandidate.trim() : baseRawPaths;
        const matcher = patternAsPath ? null : ctx.resolveMatcher(patternCandidate, op, pos);
        if (Array.isArray(rawPaths)) {
            if (rawPaths.length === 0 && op === "read") {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
            }
            const results: PlurnkStatement[] = [];
            for (const item of rawPaths) {
                if (typeof item === "string") {
                    const parsed = parsePath(tier === "model" ? withChannelFragment(item, first.channel) : item, pos);
                    const members = parsed === null ? [null] : targetMembers(parsed);
                    for (const target of members) {
                        results.push(ctx.emitStatement(op === "read" ? {
                            op: "read",
                            aside,
                            target,
                            lineMarker: toTextLineMarker(first.range ?? first.lines ?? first.line ?? first.scope, pos),
                            matcher,
                            headers,
                            body: null,
                            position: pos,
                        } : {
                            op: "find",
                            aside,
                            target,
                            lineMarker: toLineMarker(first.range ?? first.lines ?? first.line ?? first.scope ?? first.limit, pos, true),
                            matcher,
                            headers,
                            body: null,
                            position: pos,
                        }));
                    }
                } else if (isRecord(item)) {
                    const sub = buildReadOrFind(ctx, op, [{ ...first, ...item, paths: undefined, targets: undefined, note: undefined }]);
                    if (Array.isArray(sub)) results.push(...sub);
                    else results.push(sub);
                }
            }
            return results;
        }
        if (rawPaths !== undefined && rawPaths !== null && typeof rawPaths !== "string") {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} path must be a string`, "error", recovery);
        }
        const effectiveRawPath = typeof rawPaths === "string"
            ? rawPaths
            : (op === "find" && tier === "model" && matcher !== null ? "**" : undefined);
        const parsed = typeof effectiveRawPath === "string"
            ? parsePath(tier === "model" ? withChannelFragment(effectiveRawPath, first.channel) : effectiveRawPath, pos)
            : null;
        if (parsed === null && op === "read") {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "read requires a target.", "error", recovery);
        }
        const targets = parsed === null ? [null] : targetMembers(parsed);
        return targets.map((target) => ctx.emitStatement(op === "read" ? {
            op: "read",
            aside,
            target,
            lineMarker: toTextLineMarker(first.range ?? first.lines ?? first.line ?? first.scope ?? first.region, pos),
            matcher,
            headers,
            body: null,
            position: pos,
        } : {
            op: "find",
            aside,
            target,
            lineMarker: toLineMarker(first.range ?? first.lines ?? first.line ?? first.scope ?? first.region ?? first.limit, pos, true),
            matcher,
            headers,
            body: null,
            position: pos,
        }));
    }
    throw new PlurnkParseError(pos.line, pos.column, "parser", `Invalid arguments to plurnk.${op}.`, "error", recovery);
};

export const buildEdit = (
    ctx: LoweringContext,
    args: readonly unknown[],
    defaultWholeFileRange = false,
): EditStatement | EditStatement[] => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const { tier } = ctx;
    const recovery = 'mcp({ server: "plurnk", tool: "edit", arguments: { path: "path/to/file", range: "@a1b2c,@d3e4f", text: "..." } })';
    const first = args[0];
    if (typeof first === "string" && args.length >= 2) {
        const parsed = parsePath(tier === "model" ? withChannelFragment(first, undefined) : first, pos);
        if (parsed === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires a target.", "error", recovery);
        }
        const body = args[1] === null || args[1] === undefined || args[1] === "" ? null : ctx.coerceArgString(args, 1);
        const fallbackMarker = defaultWholeFileRange ? toTextLineMarker("1,-1", pos) : null;
        return targetMembers(parsed).map((target) => ctx.emitStatement({
            op: "edit",
            aside: defaultAside,
            target,
            lineMarker: fallbackMarker,
            matcher: null,
            headers: null,
            body,
            position: pos,
        }));
    }
    if (!isRecord(first)) {
        throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires an options object with `path`.", "error", recovery);
    }
    ctx.checkKeys(first, EDIT_KEYS, "plurnk.edit", recovery, pos);
    const fallbackEditId = tier === "model" && typeof first.id === "string" && first.id.trim().length > 0 ? first.id.trim() : undefined;
    const rawPath = first.path ?? first.target ?? first.uri ?? first.resource ?? first.file_path ?? first.filePath ?? first.filepath ?? first.file ?? fallbackEditId;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
        throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires a target.", "error", recovery);
    }
    const parsed = parsePath(tier === "model" ? withChannelFragment(rawPath, first.channel) : rawPath, pos);
    if (parsed === null) {
        throw new PlurnkParseError(pos.line, pos.column, "parser", "edit requires a target.", "error", recovery);
    }
    const targets = targetMembers(parsed);
    const aside = ctx.resolveAside(first);
    const headers = toHeaders(first.headers, pos);

    if (Array.isArray(first.edits)) {
        if (first.edits.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", "edit `edits` array cannot be empty.", "error", recovery);
        }
        const statements: EditStatement[] = [];
        for (const target of targets) {
            for (const item of first.edits) {
                if (!isRecord(item)) {
                    throw new PlurnkParseError(pos.line, pos.column, "visitor", "Each entry in `edits` must be an object.", "error", recovery);
                }
                ctx.checkKeys(item, EDIT_ITEM_KEYS, "plurnk.edit.edits", recovery, pos);
                const itemLineMarker = toTextLineMarker(item.range ?? item.lines ?? item.line ?? item.scope ?? first.range ?? first.lines ?? first.line ?? first.scope, pos);
                const rawItemOld = item.oldText ?? item.old_string ?? item.old_text ?? item.old ?? item.find ?? item.original;
                const itemMatcher = typeof rawItemOld === "string"
                    ? oldTextToMatcher(rawItemOld, pos)
                    : ctx.resolveMatcher(item.pattern ?? item.matcher, "edit", pos);
                const rawContent = item.text ?? item.newText ?? item.new_string ?? item.new_text ?? item.new ?? item.replace ?? item.replacement ?? item.content ?? item.body;
                const body = rawContent === undefined || rawContent === null || rawContent === ""
                    ? null
                    : ctx.coerceBodyString(rawContent);
                statements.push(ctx.emitStatement({
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

    const explicitLineMarker = toTextLineMarker(first.range ?? first.lines ?? first.line ?? first.scope, pos);
    const rawOld = first.oldText ?? first.old_string ?? first.old_text ?? first.old ?? first.find ?? first.original;
    const matcher = typeof rawOld === "string"
        ? oldTextToMatcher(rawOld, pos)
        : ctx.resolveMatcher(first.pattern ?? first.matcher, "edit", pos);
    const lineMarker = explicitLineMarker === null && matcher === null && defaultWholeFileRange
        ? toTextLineMarker("1,-1", pos)
        : explicitLineMarker;
    const rawBody = first.text ?? first.newText ?? first.new_string ?? first.new_text ?? first.new ?? first.replace ?? first.replacement ?? first.content ?? first.body;
    const body = rawBody === undefined || rawBody === null || rawBody === ""
        ? null
        : ctx.coerceBodyString(rawBody);
    return targets.map((target) => ctx.emitStatement({
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

export const buildTransfer = (
    ctx: LoweringContext,
    op: "copy" | "move",
    args: readonly unknown[],
): CopyStatement | MoveStatement => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const { tier } = ctx;
    const recovery = `mcp({ server: "plurnk", tool: "${op}", arguments: { from: "source", to: "destination" } })`;
    if (typeof args[0] === "string" && typeof args[1] === "string") {
        const source = parseSelectionInput(args[0], op, "from", pos);
        const destination = parseSelectionInput(args[1], op, "to", pos);
        return ctx.emitStatement({ op, aside: defaultAside, source, destination, position: pos });
    }
    const first = args[0];
    if (!isRecord(first)) {
        throw new PlurnkParseError(pos.line, pos.column, "parser", `${op} requires both from and to targets.`, "error", recovery);
    }
    ctx.checkKeys(first, TRANSFER_KEYS, `plurnk.${op}`, recovery, pos);
    if (typeof first.note === "string" && first.note.trim().length > 0) {
        ctx.emitStatement({ op: "note", aside: null, target: null, lineMarker: null, body: first.note, position: pos });
    }
    const rawFrom = first.from ?? first.source ?? first.src;
    const rawTo = first.to ?? first.destination ?? first.dest;
    const fromInput = tier === "model" && typeof rawFrom === "string"
        ? withChannelFragment(rawFrom, first.channel)
        : rawFrom;
    const sourceBase = parseSelectionInput(fromInput, op, "from", pos, tier === "model");
    const destBase = parseSelectionInput(rawTo, op, "to", pos, tier === "model");
    const source: ResourceSelection = {
        target: sourceBase.target,
        lineMarker: sourceBase.lineMarker ?? toTextLineMarker(first.range ?? first.lines ?? first.line ?? first.scope ?? first.sourceRange ?? first.fromRange, pos),
        matcher: sourceBase.matcher ?? ctx.resolveMatcher(first.pattern ?? first.matcher ?? first.sourcePattern ?? first.fromPattern, op, pos),
        headers: sourceBase.headers ?? toHeaders(first.headers ?? first.sourceHeaders ?? first.fromHeaders, pos),
    };
    const destination: ResourceSelection = {
        target: destBase.target,
        lineMarker: destBase.lineMarker ?? toTextLineMarker(first.toRange ?? first.destinationRange ?? first.destRange, pos),
        matcher: destBase.matcher ?? ctx.resolveMatcher(first.toPattern ?? first.destinationPattern, op, pos),
        headers: destBase.headers ?? toHeaders(first.toHeaders ?? first.destinationHeaders, pos),
    };
    return ctx.emitStatement({
        op,
        aside: ctx.resolveAside(first),
        source,
        destination,
        position: pos,
    });
};

export const buildKill = (ctx: LoweringContext, args: readonly unknown[]): KillStatement | KillStatement[] => {
    const pos = ctx.position();
    const { tier } = ctx;
    const recovery = 'mcp({ server: "plurnk", tool: "kill", arguments: { path: "log:///1/1/1/read" } })';
    const first = args[0];
    if (Array.isArray(first)) {
        if (first.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
        }
        const results: KillStatement[] = [];
        for (const item of first) {
            const sub = buildKill(ctx, [item]);
            if (Array.isArray(sub)) results.push(...sub);
            else results.push(sub);
        }
        return results;
    }
    if (typeof first === "string") {
        if (args[1] !== undefined && !isRecord(args[1])) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "kill options must be an object.", "error", recovery);
        }
        const second = isRecord(args[1]) ? args[1] : null;
        if (second !== null) {
            ctx.checkKeys(second, KILL_KEYS, "plurnk.kill", recovery, pos);
        }
        const parsed = parsePath(tier === "model" ? withChannelFragment(first, second?.channel) : first, pos);
        if (parsed === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
        }
        const lineMarker = toTextLineMarker(second?.range ?? second?.lines ?? second?.line ?? second?.scope, pos);
        const matcher = ctx.resolveMatcher(second?.pattern ?? second?.matcher, "kill", pos);
        const remote = toRemote(second?.remote, pos);
        const headers = toHeaders(second?.headers, pos);
        const aside = ctx.resolveAside(second);
        return targetMembers(parsed).map((target) => ctx.emitStatement({
            op: "kill",
            aside,
            target,
            lineMarker,
            matcher,
            remote,
            headers,
            body: null,
            position: pos,
        }));
    }
    if (isRecord(first)) {
        ctx.checkKeys(first, KILL_KEYS, "plurnk.kill", recovery, pos);
        const rawIdsArray = Array.isArray(first.ids) ? first.ids : (Array.isArray(first.streams) ? first.streams : undefined);
        const fallbackKillIds = tier === "model"
            && rawIdsArray !== undefined
            && rawIdsArray.length > 0
            && rawIdsArray.every((item) => typeof item === "string" && (item.includes("://") || /^\d+\/\d+/u.test(item.trim())))
            ? rawIdsArray
            : undefined;
        const fallbackKillId = tier === "model" && typeof first.id === "string" && first.id.trim().length > 0
            ? first.id.trim()
            : undefined;
        const rawSessionAlias = first.session ?? first.sessionId ?? first.session_id;
        const sessionKillTarget = typeof rawSessionAlias === "string" && rawSessionAlias.trim().length > 0
            ? (rawSessionAlias.includes("://") ? rawSessionAlias : `session://${rawSessionAlias.trim()}`)
            : rawSessionAlias;
        const rawStreamAlias = first.stream ?? first.streamId ?? first.stream_id ?? first.process ?? first.processId ?? first.process_id;
        const baseRawPaths = first.paths ?? first.targets ?? first.resources ?? fallbackKillIds ?? first.path ?? first.target ?? first.uri ?? first.resource ?? sessionKillTarget ?? rawStreamAlias ?? first.file_path ?? first.filePath ?? first.filepath ?? first.file ?? fallbackKillId;
        const patternCandidate = first.pattern ?? first.matcher;
        const patternAsPath = baseRawPaths === undefined
            && typeof patternCandidate === "string"
            && /^(?:workspace|file|log|session|skill|mcp|ops|reasoning|message):\/\//u.test(patternCandidate.trim());
        const rawPaths = patternAsPath ? patternCandidate.trim() : baseRawPaths;
        const aside = ctx.resolveAside(first);
        const lineMarker = toTextLineMarker(first.range ?? first.lines ?? first.line ?? first.scope, pos);
        const matcher = patternAsPath ? null : ctx.resolveMatcher(patternCandidate, "kill", pos);
        const remote = toRemote(first.remote, pos);
        const headers = toHeaders(first.headers, pos);

        if (Array.isArray(rawPaths)) {
            if (rawPaths.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
            }
            const results: KillStatement[] = [];
            for (const item of rawPaths) {
                if (typeof item === "string") {
                    const parsed = parsePath(tier === "model" ? withChannelFragment(item, first.channel) : item, pos);
                    if (parsed === null) {
                        throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
                    }
                    for (const target of targetMembers(parsed)) {
                        results.push(ctx.emitStatement({
                            op: "kill",
                            aside,
                            target,
                            lineMarker,
                            matcher,
                            remote,
                            headers,
                            body: null,
                            position: pos,
                        }));
                    }
                } else if (isRecord(item)) {
                    const sub = buildKill(ctx, [{ ...first, ...item, paths: undefined, targets: undefined }]);
                    if (Array.isArray(sub)) results.push(...sub);
                    else results.push(sub);
                }
            }
            return results;
        }
        if (typeof rawPaths !== "string" || rawPaths.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
        }
        const parsed = parsePath(tier === "model" ? withChannelFragment(rawPaths, first.channel) : rawPaths, pos);
        if (parsed === null) {
            throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
        }
        return targetMembers(parsed).map((target) => ctx.emitStatement({
            op: "kill",
            aside,
            target,
            lineMarker,
            matcher,
            remote,
            headers,
            body: null,
            position: pos,
        }));
    }
    throw new PlurnkParseError(pos.line, pos.column, "parser", "kill requires a target.", "error", recovery);
};

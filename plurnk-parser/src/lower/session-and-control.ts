import {
    PlurnkParseError,
    isRecord,
    type BareStatement,
    type DispositionStatement,
    type DoneStatement,
    type FailStatement,
    type ForkStatement,
    type NoteStatement,
    type ParsedPath,
    type Position,
    type SendBody,
    type SendStatement,
    type WorkStatement,
} from "@plurnk/plurnk-contracts";
import {
    CONCLUSION_KEYS,
    DELEGATION_KEYS,
    NOTE_KEYS,
    SEND_KEYS,
    SPAWN_DELEGATION_KEYS,
    WAIT_KEYS,
    isCallerTargetAlias,
    isConclusionCallerAlias,
    toActor,
    toAttachments,
    toHeaders,
    toSendBody,
    toStringValue,
} from "../OptionCoercion.ts";
import { parsePath, targetMembers } from "../TargetSyntax.ts";
import type { LoweringContext } from "./context.ts";

export const buildNote = (ctx: LoweringContext, args: readonly unknown[]): NoteStatement => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const first = args[0];
    if (first === undefined || first === null || first === "") {
        return ctx.emitStatement({ op: "note", aside: defaultAside, target: null, lineMarker: null, body: null, position: pos });
    }
    if (typeof first === "string") {
        return ctx.emitStatement({ op: "note", aside: defaultAside, target: null, lineMarker: null, body: first, position: pos });
    }
    if (isRecord(first)) {
        ctx.checkKeys(first, NOTE_KEYS, "plurnk.note", 'mcp({ server: "plurnk", tool: "note", arguments: { text: "..." } })', pos);
        const rawPrimary = first.text ?? first.content ?? first.body ?? first.note ?? first.message;
        let body: string | null = null;
        if (rawPrimary !== undefined && rawPrimary !== null && rawPrimary !== "") {
            body = ctx.coerceBodyString(rawPrimary);
        } else {
            const extraKeys = [
                "title",
                "discovery",
                "discoveries",
                "derivation",
                "derivations",
                "fact",
                "facts",
                "idea",
                "ideas",
                "plan",
                "plans",
                "decision",
                "decisions",
                "hypothesis",
                "hypotheses",
                "observation",
                "observations",
                "finding",
                "findings",
                "summary",
            ] as const;
            const extraParts = extraKeys
                .filter((k) => first[k] !== undefined && first[k] !== null && first[k] !== "")
                .map((k) => ctx.coerceBodyString(first[k]));
            if (extraParts.length > 0) {
                body = extraParts.join("\n");
            }
        }
        return ctx.emitStatement({ op: "note", aside: ctx.resolveAside(first), target: null, lineMarker: null, body, position: pos });
    }
    return ctx.emitStatement({ op: "note", aside: defaultAside, target: null, lineMarker: null, body: toStringValue(first), position: pos });
};

const extractSpawnOptions = (
    op: "work" | "fork",
    record: Readonly<Record<string, unknown>>,
    recovery: string,
    pos: Position,
): { readonly persona?: string; readonly model?: string; readonly effort?: string } => {
    const readOpt = (field: "persona" | "model" | "effort"): string | undefined => {
        const raw = record[field];
        if (raw === undefined || raw === null || raw === "") return undefined;
        if (typeof raw !== "string" || raw.trim().length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} ${field} must be a non-empty string.`, "error", recovery);
        }
        return raw.trim();
    };
    const persona = readOpt("persona");
    const model = readOpt("model");
    const effort = readOpt("effort");
    return {
        ...(persona === undefined ? {} : { persona }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
    };
};

export const buildDelegation = (
    ctx: LoweringContext,
    op: "work" | "fork" | "bare",
    args: readonly unknown[],
): WorkStatement | ForkStatement | BareStatement => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const recovery = `mcp({ server: "plurnk", tool: "${op}", arguments: { text: "..." } })`;
    if (typeof args[0] === "string" && typeof args[1] === "string") {
        const target = op === "bare" ? null : parsePath(args[0], pos);
        const trailingOpts = op !== "bare" && isRecord(args[2])
            ? (ctx.checkKeys(args[2], SPAWN_DELEGATION_KEYS, `plurnk.${op}`, recovery, pos), extractSpawnOptions(op, args[2], recovery, pos))
            : {};
        return ctx.emitStatement({ op, aside: defaultAside, target, lineMarker: null, body: ctx.coerceArgString(args, 1), ...trailingOpts, position: pos });
    }
    if (typeof args[0] === "string") {
        const trailingOpts = op !== "bare" && isRecord(args[1])
            ? (ctx.checkKeys(args[1], SPAWN_DELEGATION_KEYS, `plurnk.${op}`, recovery, pos), extractSpawnOptions(op, args[1], recovery, pos))
            : {};
        return ctx.emitStatement({ op, aside: defaultAside, target: null, lineMarker: null, body: ctx.coerceArgString(args, 0), ...trailingOpts, position: pos });
    }
    if (isRecord(args[0])) {
        const first = args[0];
        ctx.checkKeys(first, op === "bare" ? DELEGATION_KEYS : SPAWN_DELEGATION_KEYS, `plurnk.${op}`, recovery, pos);
        if (
            op !== "bare" &&
            first.session !== undefined &&
            first.session !== null &&
            first.session !== "" &&
            typeof first.session !== "string"
        ) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} target must be a URI string.`, "error", recovery);
        }
        const rawTarget = op === "bare"
            ? undefined
            : (first.target ?? first.path ?? first.uri ?? first.resource ?? (typeof first.session === "string" && first.session.length > 0
                ? (first.session.includes("://") ? first.session : `session://${first.session}`)
                : undefined));
        if (rawTarget !== undefined && rawTarget !== null && rawTarget !== "" && typeof rawTarget !== "string") {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} target must be a URI string.`, "error", recovery);
        }
        const target = typeof rawTarget === "string" && rawTarget.length > 0 ? parsePath(rawTarget, pos) : null;
        const rawPrompt = first.text ?? first.prompt ?? first.body ?? first.content ?? first.message;
        const body = rawPrompt === undefined || rawPrompt === null
            ? ""
            : ctx.coerceBodyString(rawPrompt);
        const spawnOpts = op === "bare" ? {} : extractSpawnOptions(op, first, recovery, pos);
        return ctx.emitStatement({ op, aside: ctx.resolveAside(first), target, lineMarker: null, body, ...spawnOpts, position: pos });
    }
    return ctx.emitStatement({ op, aside: defaultAside, target: null, lineMarker: null, body: "", position: pos });
};

const resolveReplyTargets = (
    op: "send" | "done" | "fail",
    rawTarget: unknown,
    recovery: string,
    pos: Position,
): ParsedPath[] => {
    if (rawTarget === undefined || rawTarget === null || rawTarget === "") return [];
    const isAlias = op === "send" ? isCallerTargetAlias : isConclusionCallerAlias;
    if (typeof rawTarget === "string") {
        const trimmed = rawTarget.trim();
        if (trimmed.length === 0 || isAlias(trimmed)) return [];
        const parsed = parsePath(trimmed, pos);
        return parsed === null ? [] : targetMembers(parsed);
    }
    if (Array.isArray(rawTarget)) {
        if (rawTarget.length === 0) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} target array cannot be empty.`, "error", recovery);
        }
        if (
            rawTarget.length === 1 &&
            typeof rawTarget[0] === "string" &&
            rawTarget[0].trim().length > 0 &&
            isAlias(rawTarget[0].trim())
        ) {
            return [];
        }
        const out: ParsedPath[] = [];
        for (const item of rawTarget) {
            if (typeof item !== "string" || item.trim().length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `Each ${op} target must be a non-empty URI string.`, "error", recovery);
            }
            const parsed = parsePath(item.trim(), pos);
            if (parsed === null) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `Each ${op} target must be a non-empty URI string.`, "error", recovery);
            }
            out.push(...targetMembers(parsed));
        }
        return out;
    }
    throw new PlurnkParseError(pos.line, pos.column, "visitor", `${op} target must be a URI string.`, "error", recovery);
};

const isMessageReplyScheme = (scheme: string): boolean =>
    scheme === "message" || scheme === "acp" || scheme === "schedule";

export const buildSend = (ctx: LoweringContext, args: readonly unknown[]): SendStatement | SendStatement[] => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const recovery = 'mcp({ server: "plurnk", tool: "send", arguments: { target: "session://name", text: "..." } })';
    if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
        return ctx.emitStatement({ op: "send", aside: defaultAside, target: null, lineMarker: null, headers: null, attachments: null, body: null, position: pos });
    }
    if ((typeof args[0] === "string" || Array.isArray(args[0])) && args.length >= 2 && (typeof args[1] === "string" || isRecord(args[1]))) {
        const targets = resolveReplyTargets("send", args[0], recovery, pos);
        let aside = defaultAside;
        let headers: Record<string, string> | null = null;
        let attachments: string[] | null = null;
        let actor: string | undefined;
        let body: SendBody | null = null;
        if (typeof args[1] === "string") {
            const str = ctx.coerceArgString(args, 1);
            body = str.length === 0 ? null : toSendBody(str);
        } else {
            const second = args[1];
            ctx.checkKeys(second, SEND_KEYS, "plurnk.send", recovery, pos);
            aside = ctx.resolveAside(second);
            actor = toActor(second.actor, pos);
            headers = toHeaders(second.headers, pos);
            attachments = toAttachments(second.attachments, pos);
            const rawText = second.text ?? second.content ?? second.body ?? second.message;
            body = second.json !== undefined
                ? { raw: JSON.stringify(second.json), json: second.json }
                : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(ctx.coerceBodyString(rawText)));
        }
        const actorField = actor === undefined ? {} : { actor };
        if (targets.length === 0) {
            return ctx.emitStatement({ op: "send", aside, target: null, lineMarker: null, headers, attachments, body, ...actorField, position: pos });
        }
        if (targets.length === 1) {
            return ctx.emitStatement({ op: "send", aside, target: targets[0], lineMarker: null, headers, attachments, body, ...actorField, position: pos });
        }
        if (targets.every((t) => t.kind === "url" && isMessageReplyScheme(t.scheme))) {
            const combined = parsePath(targets.map((t) => t.raw).join(","), pos)!;
            return ctx.emitStatement({ op: "send", aside, target: combined, lineMarker: null, headers, attachments, body, ...actorField, position: pos });
        }
        return targets.map((target) =>
            ctx.emitStatement({ op: "send", aside, target, lineMarker: null, headers, attachments, body, ...actorField, position: pos }),
        );
    }
    if (typeof args[0] === "string") {
        return ctx.emitStatement({ op: "send", aside: defaultAside, target: null, lineMarker: null, headers: null, attachments: null, body: toSendBody(ctx.coerceArgString(args, 0)), position: pos });
    }
    if (isRecord(args[0])) {
        const first = args[0];
        ctx.checkKeys(first, SEND_KEYS, "plurnk.send", recovery, pos);
        if (
            first.session !== undefined &&
            first.session !== null &&
            first.session !== "" &&
            typeof first.session !== "string" &&
            !Array.isArray(first.session)
        ) {
            throw new PlurnkParseError(pos.line, pos.column, "visitor", "send target must be a URI string.", "error", recovery);
        }
        const sessionTarget = typeof first.session === "string" && first.session.length > 0
            ? (first.session.includes("://") ? first.session : `session://${first.session}`)
            : Array.isArray(first.session)
                ? first.session.map((s) => (typeof s === "string" && s.length > 0 && !s.includes("://") ? `session://${s}` : s))
                : undefined;
        const rawTarget =
            first.targets ??
            first.recipients ??
            first.paths ??
            first.uris ??
            first.resources ??
            first.target ??
            first.to ??
            first.recipient ??
            first.path ??
            first.uri ??
            first.resource ??
            sessionTarget;
        const targets = resolveReplyTargets("send", rawTarget, recovery, pos);
        const aside = ctx.resolveAside(first);
        const actor = toActor(first.actor, pos);
        const actorField = actor === undefined ? {} : { actor };
        const headers = toHeaders(first.headers, pos);
        const attachments = toAttachments(first.attachments, pos);
        const rawText = first.text ?? first.content ?? first.body ?? first.message;
        const body = first.json !== undefined
            ? { raw: JSON.stringify(first.json), json: first.json }
            : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(ctx.coerceBodyString(rawText)));
        if (targets.length === 0) {
            return ctx.emitStatement({ op: "send", aside, target: null, lineMarker: null, headers, attachments, body, ...actorField, position: pos });
        }
        if (targets.length === 1) {
            return ctx.emitStatement({ op: "send", aside, target: targets[0], lineMarker: null, headers, attachments, body, ...actorField, position: pos });
        }
        if (targets.every((t) => t.kind === "url" && isMessageReplyScheme(t.scheme))) {
            const combined = parsePath(targets.map((t) => t.raw).join(","), pos)!;
            return ctx.emitStatement({ op: "send", aside, target: combined, lineMarker: null, headers, attachments, body, ...actorField, position: pos });
        }
        return targets.map((target) =>
            ctx.emitStatement({ op: "send", aside, target, lineMarker: null, headers, attachments, body, ...actorField, position: pos }),
        );
    }
    return ctx.emitStatement({ op: "send", aside: defaultAside, target: null, lineMarker: null, headers: null, attachments: null, body: toSendBody(toStringValue(args[0])), position: pos });
};

export const buildConclusion = (
    ctx: LoweringContext,
    op: "done" | "fail",
    args: readonly unknown[],
): DoneStatement | FailStatement | Array<DoneStatement | FailStatement> => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const recovery = `mcp({ server: "plurnk", tool: "${op}", arguments: { text: "..." } })`;
    if (args.length === 0) {
        return ctx.emitStatement({ op, aside: defaultAside, target: null, lineMarker: null, attachments: null, body: null, position: pos });
    }
    if (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === "")) {
        return ctx.emitStatement({ op, aside: defaultAside, target: null, lineMarker: null, attachments: null, body: null, position: pos });
    }
    if ((typeof args[0] === "string" || Array.isArray(args[0])) && typeof args[1] === "string") {
        const targets = resolveReplyTargets(op, args[0], recovery, pos);
        const str = ctx.coerceArgString(args, 1);
        const body = str.length === 0 ? null : toSendBody(str);
        if (targets.length === 0) {
            return ctx.emitStatement({ op, aside: defaultAside, target: null, lineMarker: null, attachments: null, body, position: pos });
        }
        if (targets.length === 1) {
            return ctx.emitStatement({ op, aside: defaultAside, target: targets[0], lineMarker: null, attachments: null, body, position: pos });
        }
        if (targets.every((t) => t.kind === "url")) {
            const combined = parsePath(targets.map((t) => t.raw).join(","), pos)!;
            return ctx.emitStatement({ op, aside: defaultAside, target: combined, lineMarker: null, attachments: null, body, position: pos });
        }
        return targets.map((target) =>
            ctx.emitStatement({ op, aside: defaultAside, target, lineMarker: null, attachments: null, body, position: pos }),
        );
    }
    if (typeof args[0] === "string") {
        return ctx.emitStatement({ op, aside: defaultAside, target: null, lineMarker: null, attachments: null, body: toSendBody(ctx.coerceArgString(args, 0)), position: pos });
    }
    if (isRecord(args[0])) {
        const first = args[0];
        ctx.checkKeys(first, CONCLUSION_KEYS, `plurnk.${op}`, recovery, pos);
        const rawTarget =
            first.targets ??
            first.recipients ??
            first.paths ??
            first.uris ??
            first.resources ??
            first.target ??
            first.to ??
            first.recipient ??
            first.path ??
            first.uri ??
            first.resource;
        const targets = resolveReplyTargets(op, rawTarget, recovery, pos);
        const aside = ctx.resolveAside(first);
        const attachments = toAttachments(first.attachments, pos);
        const rawText = first.text ?? first.content ?? first.body ?? first.message ?? first.reason ?? first.summary ?? first.note;
        const body = first.json !== undefined
            ? { raw: JSON.stringify(first.json), json: first.json }
            : (rawText === undefined || rawText === null || rawText === "" ? null : toSendBody(ctx.coerceBodyString(rawText)));
        if (targets.length === 0) {
            return ctx.emitStatement({ op, aside, target: null, lineMarker: null, attachments, body, position: pos });
        }
        if (targets.length === 1) {
            return ctx.emitStatement({ op, aside, target: targets[0], lineMarker: null, attachments, body, position: pos });
        }
        if (targets.every((t) => t.kind === "url")) {
            const combined = parsePath(targets.map((t) => t.raw).join(","), pos)!;
            return ctx.emitStatement({ op, aside, target: combined, lineMarker: null, attachments, body, position: pos });
        }
        return targets.map((target) =>
            ctx.emitStatement({ op, aside, target, lineMarker: null, attachments, body, position: pos }),
        );
    }
    return ctx.emitStatement({ op, aside: defaultAside, target: null, lineMarker: null, attachments: null, body: toSendBody(toStringValue(args[0])), position: pos });
};

export const buildWait = (ctx: LoweringContext, args: readonly unknown[]): DispositionStatement => {
    const pos = ctx.position();
    const defaultAside = ctx.defaultAside();
    const recovery = 'mcp({ server: "plurnk", tool: "wait", arguments: { seconds: 30 } })';
    if (args.length === 0 || (args.length === 1 && (args[0] === undefined || args[0] === null || args[0] === ""))) {
        return ctx.emitStatement({ op: "wait", aside: defaultAside, target: null, lineMarker: null, seconds: null, body: null, position: pos });
    }
    if (typeof args[0] === "number") {
        const seconds = Number.isFinite(args[0]) && args[0] >= 0 ? args[0] : null;
        const textAside = typeof args[1] === "string" && args[1].length > 0 ? ctx.coerceArgString(args, 1) : null;
        return ctx.emitStatement({ op: "wait", aside: defaultAside ?? textAside, target: null, lineMarker: null, seconds, body: null, position: pos });
    }
    if (typeof args[0] === "string") {
        const str = ctx.coerceArgString(args, 0);
        const textAside = str.length > 0 ? str : null;
        return ctx.emitStatement({ op: "wait", aside: defaultAside ?? textAside, target: null, lineMarker: null, seconds: null, body: null, position: pos });
    }
    if (isRecord(args[0])) {
        const first = args[0];
        ctx.checkKeys(first, WAIT_KEYS, "plurnk.wait", recovery, pos);
        const rawSeconds = first.seconds ?? first.duration;
        const rawMs = first.timeoutMs ?? first.timeout_ms ?? first.ms;
        let seconds: number | null = null;
        const parseNonNegativeNumber = (val: unknown): number =>
            typeof val === "number"
                ? val
                : typeof val === "string" && val.trim().length > 0
                    ? Number(val)
                    : Number.NaN;
        const parsedSeconds = parseNonNegativeNumber(rawSeconds);
        const parsedMs = parseNonNegativeNumber(rawMs);
        if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) {
            seconds = parsedSeconds;
        } else if (Number.isFinite(parsedMs) && parsedMs >= 0) {
            seconds = parsedMs / 1000;
        }
        const rawText = first.text ?? first.body ?? first.content ?? first.message ?? first.reason ?? first.note;
        const textAside = rawText === undefined || rawText === null || rawText === ""
            ? null
            : ctx.coerceBodyString(rawText);
        return ctx.emitStatement({ op: "wait", aside: ctx.resolveAside(first) ?? textAside, target: null, lineMarker: null, seconds, body: null, position: pos });
    }
    const textAside = toStringValue(args[0]);
    return ctx.emitStatement({ op: "wait", aside: defaultAside ?? (textAside.length > 0 ? textAside : null), target: null, lineMarker: null, seconds: null, body: null, position: pos });
};

import { ParserRuleContext, TerminalNode } from "antlr4ng";
import * as xpath from "xpath";
import { JSONPath } from "jsonpath-plus";
import type {
    BuffStatement,
    ClientOp,
    ClientStatement,
    CopyStatement,
    EditStatement,
    ExecStatement,
    FindStatement,
    FoldStatement,
    KillStatement,
    WorkStatement,
    ForkStatement,
    LineMarker,
    LookStatement,
    MatcherBody,
    MoveStatement,
    ParsedPath,
    PlanStatement,
    PlurnkOp,
    PlurnkStatement,
    Position,
    ReadStatement,
    SendBody,
    SendStatement,
    OpenStatement,
    UrlPath,
} from "./types.ts";
import type {
    BuffStatementContext,
    ClientStatementContext,
    CopyStatementContext,
    EditStatementContext,
    ExecModifiersContext,
    ExecStatementContext,
    FindStatementContext,
    FoldStatementContext,
    KillStatementContext,
    WorkStatementContext,
    ForkStatementContext,
    LookStatementContext,
    MoveStatementContext,
    ReadStatementContext,
    OpenStatementContext,
    StatementContext,
    MidStatementContext,
    MidSendContext,
    TagOpModifiersContext,
} from "./generated/plurnkParser.ts";
import {
    IdentSignalContext,
    LineMarkerContext,
    PlanStatementContext,
    SendStatementContext,
    TargetContext,
    TagSignalContext,
} from "./generated/plurnkParser.ts";
import { plurnkLexer } from "./generated/plurnkLexer.ts";
import PlurnkParseError from "./PlurnkParseError.ts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

type Ctor<T> = new (...args: any[]) => T;

type TagSlots = { signal: string[] | null; target: ParsedPath | null; lineMarker: LineMarker | null };
type IntSlots = { signal: number | null; target: ParsedPath | null };
type ExecSlots = { signal: string | null; target: ParsedPath | null; lineMarker: LineMarker | null };

export default class AstBuilder {
    static #SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

    static build(ctx: StatementContext | MidStatementContext | PlanStatementContext | SendStatementContext): PlurnkStatement {
        // The strict turn root attaches the leading PLAN and the terminal SEND as direct
        // children (not wrapped in `statement`), so dispatch those by type first.
        if (ctx instanceof PlanStatementContext) return AstBuilder.#buildPlan(ctx);
        if (ctx instanceof SendStatementContext) return AstBuilder.#buildSend(ctx);
        const find = ctx.findStatement(); if (find) return AstBuilder.#buildFind(find);
        const read = ctx.readStatement(); if (read) return AstBuilder.#buildRead(read);
        const edit = ctx.editStatement(); if (edit) return AstBuilder.#buildEdit(edit);
        const copy = ctx.copyStatement(); if (copy) return AstBuilder.#buildCopy(copy);
        const move = ctx.moveStatement(); if (move) return AstBuilder.#buildMove(move);
        const open = ctx.openStatement(); if (open) return AstBuilder.#buildOpen(open);
        const fold = ctx.foldStatement(); if (fold) return AstBuilder.#buildFold(fold);
        const midSend = ctx.midSend(); if (midSend) return AstBuilder.#buildSend(midSend);
        // `sendStatement` (the disposition-coded terminal) appears in `statement` (teaching
        // corpora) but NOT in `midStatement` — guard the accessor before calling it.
        if ("sendStatement" in ctx) {
            const send = ctx.sendStatement(); if (send) return AstBuilder.#buildSend(send);
        }
        const exec = ctx.execStatement(); if (exec) return AstBuilder.#buildExec(exec);
        const work = ctx.workStatement(); if (work) return AstBuilder.#buildWork(work);
        const fork = ctx.forkStatement(); if (fork) return AstBuilder.#buildFork(fork);
        const kill = ctx.killStatement(); if (kill) return AstBuilder.#buildKill(kill);
        // `midStatement` has no planStatement alternative (PLAN is never a mid-op); only the
        // full `statement` rule does.
        if ("planStatement" in ctx) {
            const plan = ctx.planStatement(); if (plan) return AstBuilder.#buildPlan(plan);
        }
        throw new Error("statement context has no recognized alternative");
    }

    static #buildFind(ctx: FindStatementContext): FindStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "FIND",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_FIND().getText(), "FIND"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    // Client-tier dispatch (parseClient). A `clientStatement` is either a protocol `statement`
    // (delegated to build, returning a PlurnkStatement — which IS a ClientStatement) or one of
    // the two client-only ops. Kept separate from build() so the protocol return type stays the
    // closed PlurnkStatement and client ops never leak into it.
    static buildClient(ctx: ClientStatementContext): ClientStatement {
        const statement = ctx.statement(); if (statement) return AstBuilder.build(statement);
        const look = ctx.lookStatement(); if (look) return AstBuilder.#buildLook(look);
        const buff = ctx.buffStatement(); if (buff) return AstBuilder.#buildBuff(buff);
        throw new Error("clientStatement context has no recognized alternative");
    }

    // LOOK / BUFF are read-shaped — identical extraction to READ (tag slots + matcher body). The
    // op discriminant is the only difference; the buffer/round-trip/write-back lifecycle is the
    // client runtime's, not the grammar's.
    static #buildLook(ctx: LookStatementContext): LookStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "LOOK",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_LOOK().getText(), "LOOK"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildBuff(ctx: BuffStatementContext): BuffStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "BUFF",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_BUFF().getText(), "BUFF"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildRead(ctx: ReadStatementContext): ReadStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "READ",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_READ().getText(), "READ"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildOpen(ctx: OpenStatementContext): OpenStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "OPEN",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_OPEN().getText(), "OPEN"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildFold(ctx: FoldStatementContext): FoldStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "FOLD",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_FOLD().getText(), "FOLD"),
            ...slots,
            body: raw !== null ? AstBuilder.#parseMatcherBody(raw, position) : null,
            position,
        };
    }

    static #buildEdit(ctx: EditStatementContext): EditStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        return {
            op: "EDIT",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_EDIT().getText(), "EDIT"),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildCopy(ctx: CopyStatementContext): CopyStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        // COPY's body is opaque: a destination path for entry copies, a prompt for
        // run forks. The scheme handler interprets it — the parser stays out of it
        // (unlike MOVE, whose body is always a genuine destination path).
        return {
            op: "COPY",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_COPY().getText(), "COPY"),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildMove(ctx: MoveStatementContext): MoveStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "MOVE",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_MOVE().getText(), "MOVE"),
            ...slots,
            body: raw !== null ? AstBuilder.parsePath(raw, position) : null,
            position,
        };
    }

    static #buildSend(ctx: SendStatementContext | MidSendContext): SendStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractIntSlots(ctx, position);
        const raw = AstBuilder.#bodyTextOf(ctx);
        return {
            op: "SEND",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_SEND().getText(), "SEND"),
            ...slots,
            // The `<T>` park on a terminal [102] (#54): wait up to T seconds, -1 = indefinite.
            // Only the terminal rule carries a marker (midSend has none -> null).
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(ctx, LineMarkerContext)),
            body: raw !== null ? AstBuilder.#parseSendBody(raw) : null,
            position,
        };
    }

    static #buildExec(ctx: ExecStatementContext): ExecStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractExecSlots(ctx.execModifiers(), position);
        return {
            op: "EXEC",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_EXEC().getText(), "EXEC"),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildPlan(ctx: PlanStatementContext): PlanStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractTagSlots(ctx.tagOpModifiers(), position);
        return {
            op: "PLAN",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_PLAN().getText(), "PLAN"),
            ...slots,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildKill(ctx: KillStatementContext): KillStatement {
        const position = AstBuilder.#positionOf(ctx);
        const slots = AstBuilder.#extractIntSlots(ctx, position);
        return {
            op: "KILL",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_KILL().getText(), "KILL"),
            ...slots,
            lineMarker: null,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildWork(ctx: WorkStatementContext): WorkStatement {
        const position = AstBuilder.#positionOf(ctx);
        return {
            op: "WORK",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_WORK().getText(), "WORK"),
            signal: null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), position),
            lineMarker: null,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #buildFork(ctx: ForkStatementContext): ForkStatement {
        const position = AstBuilder.#positionOf(ctx);
        return {
            op: "FORK",
            suffix: AstBuilder.#splitSuffix(ctx.OPEN_FORK().getText(), "FORK"),
            signal: null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), position),
            lineMarker: null,
            body: AstBuilder.#bodyTextOf(ctx),
            position,
        };
    }

    static #extractTagSlots(modCtx: TagOpModifiersContext | null, pos: Position): TagSlots {
        return {
            signal: AstBuilder.#tagsFromSignal(AstBuilder.#findFirst(modCtx, TagSignalContext)),
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
        };
    }

    // A SEND/KILL signal is one signed-integer literal, tokenized as INT (mid-comms SEND, KILL)
    // or DISPOSITION (the terminal SEND — the parser tokenizes {102,200,202,300,499} distinctly
    // so a disposition-coded SEND is structurally terminal). `ctx` is the whole SEND/KILL
    // statement; the only INT/DISPOSITION token is the signal, the only target the recipient.
    static #extractIntSlots(ctx: ParserRuleContext | null, pos: Position): IntSlots {
        const sig = AstBuilder.#findToken(ctx, plurnkLexer.INT) ?? AstBuilder.#findToken(ctx, plurnkLexer.DISPOSITION);
        return {
            signal: sig !== null ? Number.parseInt(sig, 10) : null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(ctx, TargetContext), pos),
        };
    }

    // Depth-first search for the first terminal of `tokenType`; returns its text or null.
    // Lets the SEND/KILL signal read work regardless of which signal rule wrapped it.
    static #findToken(root: ParserRuleContext | null, tokenType: number): string | null {
        if (root === null) return null;
        for (const child of root.children ?? []) {
            if (child instanceof TerminalNode && child.symbol.type === tokenType) return child.getText();
            if (child instanceof ParserRuleContext) {
                const found = AstBuilder.#findToken(child, tokenType);
                if (found !== null) return found;
            }
        }
        return null;
    }

    static #extractExecSlots(modCtx: ExecModifiersContext | null, pos: Position): ExecSlots {
        const identCtx = AstBuilder.#findFirst(modCtx, IdentSignalContext);
        const identNode = identCtx?.IDENT() ?? null;
        return {
            signal: identNode !== null ? identNode.getText() : null,
            target: AstBuilder.#targetFromCtx(AstBuilder.#findFirst(modCtx, TargetContext), pos),
            lineMarker: AstBuilder.#lineMarkerFromCtx(AstBuilder.#findFirst(modCtx, LineMarkerContext)),
        };
    }

    static #findFirst<T extends ParserRuleContext>(
        root: ParserRuleContext | null,
        type: Ctor<T>,
    ): T | null {
        if (root === null) return null;
        if (root instanceof type) return root;
        const children = root.children;
        if (!children) return null;
        for (const child of children) {
            if (child instanceof ParserRuleContext) {
                const found = AstBuilder.#findFirst(child, type);
                if (found !== null) return found;
            }
        }
        return null;
    }

    static #tagsFromSignal(ctx: TagSignalContext | null): string[] | null {
        if (ctx === null) return null;
        const tags = ctx.TAG();
        return Array.isArray(tags) ? tags.map((t) => t.getText()) : [];
    }

    static #targetFromCtx(ctx: TargetContext | null, pos: Position): ParsedPath | null {
        if (ctx === null) return null;
        const text = ctx.TARGET_TEXT()?.getText() ?? "";
        return AstBuilder.parsePath(text, pos);
    }

    static #lineMarkerFromCtx(ctx: LineMarkerContext | null): LineMarker | null {
        if (ctx === null) return null;
        const text = ctx.L_MARKER()?.getText() ?? "";
        return AstBuilder.#parseLineMarker(text);
    }

    static #positionOf(ctx: { start: { line: number; column: number } | null }): Position {
        const start = ctx.start;
        return { line: start?.line ?? 0, column: start?.column ?? 0 };
    }

    static #bodyTextOf(ctx: { body(): { getText(): string } | null }): string | null {
        const bodyCtx = ctx.body();
        return bodyCtx ? bodyCtx.getText() : null;
    }

    static #splitSuffix(openTagText: string, op: PlurnkOp | ClientOp): string {
        return openTagText.slice(2 + op.length);
    }

    static #isDigit(c: string | undefined): boolean {
        return c !== undefined && c >= "0" && c <= "9";
    }

    // Scans the `<L>` slot into its ordered numeric components. Separators are `,`
    // (with an optional space) or `-`; a `-` immediately starting a component is its
    // sign, not a separator. Roles (position / range / threshold) are the consumer's
    // to assign — the parser only carries the numbers.
    static #parseLineMarker(text: string): LineMarker {
        const inner = text.slice(1, -1);
        const marks: number[] = [];
        let i = 0;
        while (i < inner.length) {
            let j = i;
            if (inner[j] === "-") j++;
            while (AstBuilder.#isDigit(inner[j])) j++;
            if (inner[j] === "." && AstBuilder.#isDigit(inner[j + 1])) {
                j++;
                while (AstBuilder.#isDigit(inner[j])) j++;
            }
            marks.push(Number.parseFloat(inner.slice(i, j)));
            i = j;
            if (inner[i] === ",") {
                i++;
                if (inner[i] === " ") i++;
            } else if (inner[i] === "-") {
                i++;
            } else {
                break;
            }
        }
        // L_MARKER always matches at least one number, so marks is non-empty.
        return { marks: marks as [number, ...number[]] };
    }

    /**
     * Parse a path string into a ParsedPath, mirroring how the AST visitor
     * decomposes path slots inside HEREDOC statements. Public for consumers
     * (RPC layers, scheme handlers) that need to honor the grammar's
     * authority-vs-opaque cleavage without round-tripping through a fake
     * HEREDOC. Returns null when `raw` is empty. Throws PlurnkParseError
     * when `raw` starts with `scheme://` but WHATWG URL rejects it.
     */
    static parsePath(raw: string, pos: Position = { line: 0, column: 0 }): ParsedPath | null {
        if (raw.length === 0) return null;
        // A leading `#` dispatches a path-name regex (`#pattern#flags`) — an
        // addressing pattern over paths, not a single address. `#` is collision-
        // free here: scheme paths never lead with it, and `#channel` is a postfix.
        // Try-then-fall-back-to-local mirrors the matcher dispatch: a malformed
        // `#…` (no closing `#`, bad flags) is just a local path that starts with `#`.
        if (raw.startsWith("#")) {
            const regex = AstBuilder.#tryParseRegex(raw);
            if (regex !== null) return { kind: "regex", raw, ...regex };
        }
        if (!AstBuilder.#SCHEME_PATTERN.test(raw)) {
            return { kind: "local", raw };
        }
        // Split trailing `{key: value}` header blocks (http request metadata: auth,
        // content-type, …) off the URL before WHATWG decomposition — `new URL()`
        // rejects the unencoded `{`. `{`/`}` are illegal unencoded in a URI (RFC 3986),
        // so the first `{` is an unambiguous marker. The blocks are opaque to the
        // grammar's addressing; the scheme handler interprets them (see #46).
        const braceIdx = raw.indexOf("{");
        const urlPart = braceIdx === -1 ? raw : raw.slice(0, braceIdx);
        const headers = braceIdx === -1 ? null : AstBuilder.#splitHeaders(raw.slice(braceIdx), pos);
        let url: URL;
        try {
            url = new URL(urlPart);
        } catch (e) {
            const detail = e instanceof Error ? e.message : raw;
            throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid URI in path: ${detail}`);
        }
        // Uniform WHATWG decomposition — no per-scheme authority allowlist. `://`
        // introduces an authority for every scheme; an authority-less reference
        // writes the empty-authority form `scheme:///path` (host parses empty).
        // Whether a given scheme should carry an authority is a runtime concern,
        // not the grammar's; the parser just reports what the standard parsed.
        const parsed: UrlPath = {
            kind: "url",
            raw,
            scheme: url.protocol.replace(/:$/, ""),
            username: url.username || null,
            password: url.password || null,
            hostname: url.hostname || null,
            port: url.port ? Number.parseInt(url.port, 10) : null,
            pathname: url.pathname,
            params: AstBuilder.#paramsFrom(url.searchParams),
            fragment: url.hash ? url.hash.slice(1) : null,
        };
        if (headers) parsed.headers = headers;
        return parsed;
    }

    // Split a target's trailing `{key: value}` header region into ordered pairs.
    // Each block is one header (the value ends at `}`, so commas inside a value are
    // fine); the key is the text before the first `:`, the value the trimmed rest
    // (internal colons kept). Fail-hard on a malformed region (stray text, unclosed
    // `{`, or a keyless block) — a header slot the scheme can't read is a contract
    // violation, not something to swallow.
    static #splitHeaders(meta: string, pos: Position): [string, string][] {
        const headers: [string, string][] = [];
        let i = 0;
        while (i < meta.length) {
            if (meta[i] !== "{") {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid header metadata: expected \`{\` at \`${meta.slice(i)}\``);
            }
            const end = meta.indexOf("}", i + 1);
            if (end === -1) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid header metadata: unclosed \`{\` in \`${meta.slice(i)}\``);
            }
            const inner = meta.slice(i + 1, end);
            const colon = inner.indexOf(":");
            if (colon === -1) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid header metadata: no \`:\` in \`{${inner}}\``);
            }
            const key = inner.slice(0, colon).trim();
            if (key.length === 0) {
                throw new PlurnkParseError(pos.line, pos.column, "visitor", `invalid header metadata: empty key in \`{${inner}}\``);
            }
            headers.push([key, inner.slice(colon + 1).trim()]);
            i = end + 1;
        }
        return headers;
    }

    static #paramsFrom(sp: URLSearchParams): Record<string, string | string[]> {
        const params: Record<string, string | string[]> = {};
        for (const [key, value] of sp) {
            const existing = params[key];
            if (existing === undefined) {
                params[key] = value;
            } else if (Array.isArray(existing)) {
                existing.push(value);
            } else {
                params[key] = [existing, value];
            }
        }
        return params;
    }

    // Matcher dispatch: try the prefix-indicated dialect; if it doesn't parse cleanly,
    // fall through to glob. Same robustness principle for every prefix — dispatch is a
    // hint, not a gate. Lets literal `//`-comments, `#…`-strings, and `$`-prefixed
    // shell-ish text reach the model as glob matches instead of hard-erroring.
    // Regex is `#pattern#flags` (`#` chosen over `/` so it never collides with path
    // `/` or regex's own `|` alternation). Semantic (`~`) and graph (`@`) have no
    // parse step — any text is a valid query — so they dispatch directly.
    static #parseMatcherBody(body: string, pos: Position): MatcherBody {
        if (body.startsWith("//")) {
            try { xpath.parse(body); return { dialect: "xpath", raw: body }; }
            catch { /* fall through to glob */ }
        } else if (body.startsWith("#")) {
            const regex = AstBuilder.#tryParseRegex(body);
            if (regex !== null) return { dialect: "regex", raw: body, ...regex };
        } else if (body.startsWith("$")) {
            try { JSONPath({ path: body, json: {} }); return { dialect: "jsonpath", raw: body }; }
            catch { /* fall through to glob */ }
        } else if (body.startsWith("~")) {
            return { dialect: "semantic", raw: body };
        } else if (body.startsWith("@")) {
            return { dialect: "graph", raw: body };
        }
        return { dialect: "glob", raw: body };
    }

    // Splits a `#pattern#flags` literal. Assumes raw[0] is the opening `#`. `\#`
    // escapes a literal hash inside the pattern. Returns null on no closing `#` or
    // an invalid pattern/flags pair, so callers can fall back (glob / local path).
    static #tryParseRegex(raw: string): { pattern: string; flags: string } | null {
        let i = 1;
        while (i < raw.length) {
            if (raw[i] === "\\") { i += 2; continue; }
            if (raw[i] === "#") break;
            i++;
        }
        if (i >= raw.length) return null;
        const pattern = raw.slice(1, i);
        const flags = raw.slice(i + 1);
        try { new RegExp(pattern, flags); } catch { return null; }
        return { pattern, flags };
    }

    static #parseSendBody(raw: string): SendBody {
        let json: unknown | null = null;
        try { json = JSON.parse(raw); } catch { /* best-effort */ }
        return { raw, json };
    }
}

import * as xpath from "xpath";
import { JSONPathEnvironment } from "json-p3";
import { isRecord, writtenOp, type MatcherBody, type ParsedPath, type PlurnkStatement, type Position } from "@plurnk/plurnk-contracts";
import { TAIL_POSITIONS, TAIL_RELATIVE_SCOPE, TAIL_TEXT_SCOPE, type Advise } from "./ScopeSyntax.ts";

// The xpath package's .d.ts omits its `parse` function; augment here.
declare module "xpath" {
    export function parse(expression: string): unknown;
}

export const SIGIL = /^(\/|\$|~|&|\^)/u;

// Compile-only RFC 9535 admission using the runtime's JSONPath engine. {§matcher-prefix-claims}
const JSONPATH = new JSONPathEnvironment();
const GRAPH_MATCHER = /^&[<>]?[^\s<>]\S*$/u;

// {§parse-recovery} — the working form for a refused regex: the dialect's own, never a reading of the input.
const REGEX_FORM = "A pattern is a regex written `/pattern/flags`, such as `/timeout/i`.";

export type BareMatcher = {
    text: string;
    aside: string | null;
    scope: string | null;
    metadata: string | null;
};

export type LiftedMatcher = {
    matcher: MatcherBody | null;
    metadata: string[] | null;
    aside: string | null;
    scope: string | null;
    consumed: boolean;
};

// {§slot-order} — shared by reading and rendering: a matcher that parses as one is written as its option.
export const isJsonObject = (text: string): boolean => {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        return false;
    }
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
};

// {§parse-recovery} — shared by trailing-block recognition; invalid blocks remain owner input.
export const metadataOptions = (metadata: readonly string[] | null | undefined): Record<string, unknown> | null => {
    if (metadata?.length !== 1) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(`[${metadata[0]}]`); }
    catch (cause) {
        if (!(cause instanceof SyntaxError)) throw cause;
        return null;
    }
    if (!Array.isArray(parsed) || !parsed.every(isRecord)) return null;
    return Object.fromEntries(parsed.flatMap((record) => Object.entries(record)));
};

const isJsonArrayOfObjects = (inner: string): boolean => metadataOptions([inner]) !== null;

// {§parse-recovery} — the receipts that name the log's heading notation where a model wrote it.
export const chargeAdvisory = (written: string): string =>
    written.trim() === "\u00B7"
        ? "`\u00B7` is how the log separates a heading from its token charge; it is not part of an operation and was ignored."
        : `\`${written.trim()}\` is the token charge the log shows on a heading; it is not part of an operation and was ignored.`;

// {§parse-recovery} — a middle-dot note before a comment: the comment is the aside, the note is named (#1005).
export const strayDotAdvisory = (written: string, aside: string | null): string =>
    `\`${written}\` was ignored; the aside is \`<!-- ${aside ?? ""} -->\`.`;

export const dotAsideAdvisory = (aside: string): string =>
    `\`\u00B7 ${aside}\` was read as the aside; a note on an operation is written \`<!-- ${aside} -->\`.`;

// {§slot-order} — the operation ran without the scope it cannot take; say which slots it has.
export const scopelessAdvisory = (statement: PlurnkStatement, scope: string): string => {
    const op = writtenOp(statement);
    const slots = op === "NOTE" ? "`NOTE` takes no target or scope"
        : op === "SEND" ? "`SEND` without a recipient takes no scope"
            : `\`${op}\` takes a target only`;
    return `${slots}; the scope \`${scope}\` was ignored.`;
};

export const formatHeadingNotation = (
    note: { kind: string; text: string },
    statement: PlurnkStatement,
    heading: (statement: PlurnkStatement) => string,
): string =>
    note.kind === "arrow"
        ? `\`${note.text}\` is how the log shows an address; it was read as the target. Write the target in parentheses: \`${heading(statement)}\`.`
        : note.kind === "charge" ? chargeAdvisory(note.text)
            : note.kind === "aside" ? dotAsideAdvisory(note.text.replace(/^\u00B7[ \t]*/u, "").trim())
                : note.kind === "stray" ? strayDotAdvisory(note.text.trim(), statement.aside)
                    : note.kind === "scope" ? scopelessAdvisory(statement, note.text)
                        : `\`${note.text}\` was read as the scope \`<${note.text}>\`; a scope is written in angle brackets.`;

// The index of the slash that closes a `/pattern/` regex, or -1: escapes and character classes hold slashes.
const regexClose = (raw: string): number => {
    let inClass = false;
    for (let i = 1; i < raw.length; i++) {
        if (raw[i] === "\\") { i++; continue; }
        if (raw[i] === "[") inClass = true;
        else if (raw[i] === "]" && inClass) inClass = false;
        else if (raw[i] === "/" && !inClass) return i;
    }
    return -1;
};

// `/pattern/flags · words`: a closed regex, then a middle-dot note, which is the aside.
const dotNote = (text: string): { matcher: string; aside: string } | null => {
    if (!text.startsWith("/") || text.startsWith("//")) return null;
    const close = regexClose(text);
    if (close === -1) return null;
    const note = /^([A-Za-z]*)\s+\u00B7[ \t]*(\S.*)$/u.exec(text.slice(close + 1));
    if (note === null) return null;
    return { matcher: text.slice(0, close + 1 + note[1].length), aside: note[2].trim() };
};

// {§parse-recovery} — one line of matcher text, its trailing aside split back out. A sigil
// (`/`, `//`, `$`, `~`, `&`, `^`) claims its dialect; a sigil-less glob or literal
// is one only on the heading line of FIND, READ or KILL, where the text can mean nothing else.
// {§parse-recovery} — the slots after the matcher peel off the right end of the heading text,
// aside, scope and option block in any order, until what remains is the matcher.
export const bareMatcher = (
    raw: string | null,
    op: string,
    position: Position | undefined,
    carried: { scope: boolean; metadata: boolean } = { scope: false, metadata: false },
    advise?: Advise,
): BareMatcher | null => {
    if (raw === null) return null;
    let text = raw.trim();
    if (text === "" || text.includes("\n")) return null;
    let aside: string | null = null;
    let scope: string | null = null;
    let metadata: string | null = null;
    // A slot the heading already carries is not peeled: a second one is trailing text.
    let scopeFree = !carried.scope;
    let metadataFree = !carried.metadata;
    const scopeTail = op === "FIND" ? TAIL_POSITIONS : TAIL_TEXT_SCOPE;
    for (;;) {
        // {§parse-recovery} — a trailing ` · N` is the log's token charge, never part of the matcher.
        const charge = /\s+(\u00B7[ \t]*(?:[0-9]+(?:[ \t]+tokens)?)?)\s*$/u.exec(text);
        if (charge !== null && charge.index > 0) {
            text = text.slice(0, charge.index).trim();
            advise?.(position, chargeAdvisory(charge[1]));
            continue;
        }
        const note: { matcher: string; aside: string } | null = aside === null ? dotNote(text) : null;
        if (note !== null) {
            aside = note.aside;
            text = note.matcher;
            advise?.(position, dotAsideAdvisory(note.aside));
            continue;
        }
        const trailingAside = /\s*<!--([\s\S]*?)-->\s*$/u.exec(text);
        if (trailingAside !== null && aside === null) {
            aside = (trailingAside[1] ?? "").trim();
            text = text.slice(0, trailingAside.index).trim();
            continue;
        }
        const trailingScope = scopeTail.exec(text) ?? TAIL_RELATIVE_SCOPE.exec(text);
        if (trailingScope !== null && scopeFree && trailingScope.index > 0) {
            scope = trailingScope[1]!;
            scopeFree = false;
            text = text.slice(0, trailingScope.index).trim();
            advise?.(position, `\`${scope}\` after the pattern was read as the scope; the scope goes before the pattern.`);
            continue;
        }
        const trailingBlock = /\s*\[(\{[\s\S]*\})\]\s*$/u.exec(text);
        if (trailingBlock !== null && metadataFree && trailingBlock.index > 0 && isJsonArrayOfObjects(trailingBlock[1])) {
            metadata = trailingBlock[1]!;
            metadataFree = false;
            text = text.slice(0, trailingBlock.index).trim();
            advise?.(position, `\`[${metadata}]\` after the pattern was read as the option block; options go before the pattern.`);
            continue;
        }
        break;
    }
    if (text === "") return null;
    // {§fence-pairing} — a sigil pattern quoted in single backticks is that pattern (#758).
    const ticked = /^`([^`]+)`$/u.exec(text);
    if (ticked !== null && SIGIL.test(ticked[1])) text = ticked[1]!;
    if (SIGIL.test(text)) return { text, aside, scope, metadata };
    if (op !== "FIND" && op !== "READ" && op !== "KILL") return null;
    // {§slot-order} — here the same text is the matcher, and one advisory says so.
    if (metadataFree && text.startsWith("{") && isJsonObject(text)) advise?.(position, "`{…}` was read as the matcher.");
    return { text, aside, scope, metadata };
};

// {§matcher-prefix-claims} — a matcher the parser cannot read is the operation's own refusal, never a parse
// error: the statement is admitted with the diagnostic and its working form, and the operation lands
// as a 400 row carrying that recovery, soft on the rail.
const unreadable = (raw: string, message: string, recovery: string): MatcherBody => ({
    dialect: "unreadable",
    raw,
    message,
    recovery,
});

const detail = (e: unknown): string => e instanceof Error ? e.message : String(e);

// {§matcher-prefix-claims} — grep's `\|` is alternation in this dialect's terms; a literal pipe is `[|]`.
const readAlternation = (pattern: string, pos: Position, advise?: Advise): string => {
    let out = ""; let read = false;
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === "\\" && i + 1 < pattern.length) {
            if (pattern[i + 1] === "|") { out += "|"; read = true; i += 1; continue; }
            out += ch + pattern[i + 1]; i += 1; continue;
        }
        out += ch;
    }
    if (read) {
        advise?.(pos, "`\\|` was read as alternation, `|`; a literal pipe is `[|]`.");
    }
    return out;
};

// {§matcher-prefix-claims} — a `/pattern/` that fails to compile on a leading or doubled `*` or `?` and
// is otherwise glob-shaped is read as that glob over each line: `*` is `.*`, `?` is `.`.
const readGlobRegex = (inner: string, flags: string, raw: string, pos: Position, advise?: Advise): { pattern: string; flags: string } | null => {
    if (!/^[\w*?./ -]+$/u.test(inner) || !/[*?]/u.test(inner)) return null;
    const pattern = inner.replace(/[.]/gu, "\\.").replace(/\*+/gu, ".*").replace(/\?/gu, ".");
    try { new RegExp(pattern, flags); } catch { return null; }
    advise?.(pos, `\`${raw}\` was read as the glob \`${inner}\` over each line, the regex \`/${pattern}/${flags}\`; a pattern is a regex, and \`*\` repeats what precedes it.`);
    return { pattern, flags };
};

// Splits an ECMAScript `/pattern/flags` literal. Backslash escapes and character
// classes keep a slash inside the pattern; the first unescaped slash outside a
// class closes it. The native constructor owns pattern and flag validity.
// {§parse-recovery} — a leading PCRE inline modifier such as `(?i)` is the pretrained
// spelling of a flag; ECMAScript refuses the group, so it is lifted into the flags with one
// advisory rather than refused.
const liftInlineFlags = (pattern: string, flags: string, pos: Position, advise?: Advise): { pattern: string; flags: string } => {
    const inline = /^\(\?([ims]+)\)/u.exec(pattern);
    if (inline === null) return { pattern, flags };
    const lifted = Array.from(new Set(flags + inline[1])).join("");
    advise?.(pos, `\`${inline[0]}\` was read as the \`${inline[1]}\` flag; an ECMAScript regex takes its flags after the closing \`/\`.`);
    return { pattern: pattern.slice(inline[0].length), flags: lifted };
};

// {§parse-recovery}
const isSedRange = (raw: string): boolean =>
    /^\/(?:\\.|[^\\/])+\/\s*,\s*(?:\/(?:\\.|[^\\/])+\/|\+\d+)?\s*$/u.test(raw);

const tryParseSlashRegex = (raw: string, pos: Position, advise?: Advise):
    { ok: true; pattern: string; flags: string }
    | { ok: false; reason: "empty" }
    | { ok: false; reason: "trailing" }
    | { ok: false; reason: "invalid"; detail: string; flags: string; pattern: string } => {
    let i = 1;
    let inClass = false;
    while (i < raw.length) {
        if (raw[i] === "\\") { i += 2; continue; }
        if (raw[i] === "[") {
            inClass = true;
            i++;
            continue;
        }
        if (raw[i] === "]" && inClass) {
            inClass = false;
            i++;
            continue;
        }
        if (raw[i] === "/" && !inClass) break;
        i++;
    }
    if (i >= raw.length) {
        // {§parse-recovery} — the heading's own boundaries make the rest the whole pattern.
        if (raw.length === 1) return { ok: false, reason: "empty" };
        const inline = liftInlineFlags(readAlternation(raw.slice(1), pos, advise), "", pos, advise);
        try { new RegExp(inline.pattern, inline.flags); }
        catch (e) { return { ok: false, reason: "invalid", detail: detail(e), flags: inline.flags, pattern: inline.pattern }; }
        const excerpt = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
        advise?.(pos, `\`${excerpt}\` has no closing \`/\`; it was read as the whole pattern with no flags. A regex closes with \`/\` and takes its flags after it.`);
        return { ok: true, pattern: inline.pattern, flags: inline.flags };
    }
    const authored = raw.slice(i + 1);
    // {§matcher-prefix-claims} — `-i` after the closing slash is the flag `i`, as a shell would take it.
    const shell = /^[\t ]*-([A-Za-z]+)[\t ]*$/u.exec(authored);
    if (shell !== null) {
        advise?.(pos, `\`-${shell[1]}\` after the pattern was read as the flags \`${shell[1]}\`; flags go right after the closing \`/\`.`);
    }
    const trailing = shell === null ? /^([A-Za-z]*)[\t ]/u.exec(authored) : null;
    const inline = liftInlineFlags(readAlternation(raw.slice(1, i), pos, advise), shell?.[1] ?? trailing?.[1] ?? authored, pos, advise);
    const { pattern, flags } = inline;
    try { new RegExp(pattern, flags); }
    catch (e) { return { ok: false, reason: "invalid", detail: detail(e), flags, pattern }; }
    if (trailing !== null) return { ok: false, reason: "trailing" };
    return { ok: true, pattern, flags };
};

export const parseMatcherBody = (body: string, pos: Position, advise?: Advise): MatcherBody => {
    // At statement EOF ANTLR retains one ordinary terminating line ending in
    // BODY_TEXT; before a following heading the lexer consumes that same EOL as
    // SECTION_END. Normalize the equivalent surfaces before enforcing one line.
    const raw = body.replace(/(?:\r\n|\r|\n)$/u, "");
    const lineCount = raw.split(/\r\n|\r|\n/u).length;
    if (lineCount !== 1) {
        return unreadable(raw, `Matcher has ${lineCount} lines; expected 1.`,
            "Write the pattern on one line, on the opening fence line after the path.");
    }
    if (raw.startsWith("//")) {
        try { xpath.parse(raw); }
        catch (e) {
            return unreadable(raw, `pattern leads with \`//\` but is not a valid xpath selector - ${detail(e)}`,
                "Write an XPath 1.0 selector after `//`, such as `//dependencies/*`.");
        }
        return { dialect: "xpath", raw };
    }
    // {§parse-recovery} — a matcher opening with `^` is a regex written without slashes or flags.
    if (raw.startsWith("^")) {
        const inline = liftInlineFlags(readAlternation(raw.slice(1), pos, advise), "", pos, advise);
        const pattern = `^${inline.pattern}`;
        try { new RegExp(pattern, inline.flags); }
        catch (e) {
            return unreadable(raw, `pattern leads with \`^\` but is not a valid regex - ${detail(e)}`,
                REGEX_FORM);
        }
        return { dialect: "regex", raw, pattern, flags: inline.flags };
    }
    if (raw.startsWith("/")) {
        const regex = tryParseSlashRegex(raw, pos, advise);
        if (regex.ok) return { dialect: "regex", raw, pattern: regex.pattern, flags: regex.flags };
        if (isSedRange(raw)) return unreadable(raw,
            "Regex matcher contains a range suffix after its closing `/`.", REGEX_FORM);
        if (regex.reason === "trailing") {
            return unreadable(raw, "Regex matcher has trailing text after `/pattern/flags`.",
                "Write only `/pattern/flags` in the matcher; flags are optional.");
        }
        if (regex.reason === "invalid") {
            const glob = readGlobRegex(regex.pattern, regex.flags, raw, pos, advise);
            if (glob !== null) return { dialect: "regex", raw, pattern: glob.pattern, flags: glob.flags };
        }
        const slashRecovery = regex.reason === "invalid"
            && regex.detail.includes("Invalid flags supplied")
            ? " - use only ECMAScript flags after the closing `/`"
            : "";
        // Quote the offending matcher so a multi-op emission's failure is
        // unambiguous about WHICH body failed (a correct sibling regex must
        // not take the blame for a broken one).
        const excerpt = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
        return unreadable(raw,
            regex.reason === "empty"
                ? "`/` opens a regex matcher but no pattern follows it; write `/pattern/flags`, flags optional."
                : `pattern leads with \`/\` but is not a valid \`/pattern/flags\` regex - ${regex.detail}${slashRecovery}: \`${excerpt}\``,
            regex.reason === "empty" ? "Write `/pattern/flags`, flags optional, such as `/timeout/i`." : REGEX_FORM);
    }
    if (raw.startsWith("$")) {
        // Compile-only RFC 9535 admission through the shared json-p3 engine.
        try { JSONPATH.compile(raw); }
        catch (e) {
            return unreadable(raw, `pattern leads with \`$\` but is not a valid jsonpath - ${detail(e)}`,
                "Write an RFC 9535 JSONPath after `$`, such as `$.items[?(@.price>500)]`.");
        }
        return { dialect: "jsonpath", raw };
    }
    if (raw.startsWith("~")) return { dialect: "fts", raw };
    if (raw.startsWith("&")) {
        if (!GRAPH_MATCHER.test(raw)) {
            return unreadable(raw, "Malformed graph matcher; expected `&symbol`, `&<symbol`, or `&>symbol`.",
                "Write `&symbol` for a symbol, `&<symbol` for what calls it, or `&>symbol` for what it calls.");
        }
        return { dialect: "graph", raw };
    }
    return { dialect: "glob", raw };
};

export const liftBareMatcher = (
    bare: BareMatcher | null,
    metadata: string[] | null,
    position: Position,
    target: ParsedPath | null,
    advise?: Advise,
): LiftedMatcher => {
    if (bare === null) return { matcher: null, metadata, aside: null, scope: null, consumed: false };
    // {§op-shapes}: a bare channel suffix belongs to each selected target.
    const channel = target === null ? null : /^#([A-Za-z][A-Za-z0-9_-]*)$/u.exec(bare.text);
    const attaches = channel !== null && target!.fragment == null;
    if (attaches) {
        target!.fragment = channel[1]!;
        if (target!.kind === "url") target!.raw = `${target!.raw}#${channel[1]}`;
    }
    return {
        matcher: attaches ? null : parseMatcherBody(bare.text, position, advise),
        metadata: metadata ?? (bare.metadata === null ? null : [bare.metadata]),
        aside: bare.aside, scope: bare.scope, consumed: true,
    };
};

// `consumed` says whether `raw` was read: as the matcher, or as the target's channel.
export const liftMatcher = (
    op: string,
    metadata: string[] | null,
    position: Position,
    raw: string | null = null,
    carriedScope = false,
    target: ParsedPath | null = null,
    advise?: Advise,
): LiftedMatcher => {
    const bare = bareMatcher(raw, op, position, { scope: carriedScope, metadata: metadata !== null }, advise);
    return liftBareMatcher(bare, metadata, position, target, advise);
};

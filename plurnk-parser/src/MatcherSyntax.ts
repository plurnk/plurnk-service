import xpath from "xpath";
import { JSONPathEnvironment } from "json-p3";
import type { MatcherBody, Position } from "@plurnk/plurnk-contracts";
import type { Advise } from "./ScopeSyntax.ts";

const JSONPATH = new JSONPathEnvironment();

// {§matcher-prefix-claims}: `&symbol`, `&<symbol` (references to), `&>symbol` (definitions of dependencies).
const GRAPH_MATCHER = /^&[<>]?[^&\s]+$/;
const REGEX_FORM = "A pattern is a regex written `/pattern/flags`, flags optional, such as `/timeout/i`; escape a literal `/` as `\\/`.";

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
    /^\/(?:\\.|[^\\/])+\/[a-z]*(?:\s*,\s*(?:\/(?:\\.|[^\\/])+\/[a-z]*|[+-]?\d+)?)+$/iu.test(raw);

const tryParseSlashRegex = (raw: string, pos: Position, advise?: Advise):
    { ok: true; pattern: string; flags: string }
    | { ok: false; reason: "empty" }
    | { ok: false; reason: "trailing" }
    | { ok: false; reason: "invalid"; detail: string; flags: string; pattern: string } => {
    const staged: [Position | undefined, string][] = [];
    const stage: Advise = (p, m) => { staged.push([p, m]); };
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
        if (raw.length === 1) return { ok: false, reason: "empty" };
        const inline = liftInlineFlags(readAlternation(raw.slice(1), pos, stage), "", pos, stage);
        try { new RegExp(inline.pattern, inline.flags); }
        catch (e) { return { ok: false, reason: "invalid", detail: detail(e), flags: inline.flags, pattern: inline.pattern }; }
        const excerpt = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
        for (const [p, m] of staged) advise?.(p, m);
        advise?.(pos, `\`${excerpt}\` has no closing \`/\`; it was read as the whole pattern with no flags. A regex closes with \`/\` and takes its flags after it.`);
        return { ok: true, pattern: inline.pattern, flags: inline.flags };
    }
    const authored = raw.slice(i + 1);
    // {§matcher-prefix-claims} — `-i` after the closing slash is the flag `i`, as a shell would take it.
    const shell = /^[\t ]*-([A-Za-z]+)[\t ]*$/u.exec(authored);
    if (shell !== null) {
        stage(pos, `\`-${shell[1]}\` after the pattern was read as the flags \`${shell[1]}\`; flags go right after the closing \`/\`.`);
    }
    const trailing = shell === null ? /^([A-Za-z]*)[\t ]/u.exec(authored) : null;
    const inline = liftInlineFlags(readAlternation(raw.slice(1, i), pos, stage), shell?.[1] ?? trailing?.[1] ?? authored, pos, stage);
    const { pattern, flags } = inline;
    try { new RegExp(pattern, flags); }
    catch (e) { return { ok: false, reason: "invalid", detail: detail(e), flags, pattern }; }
    if (trailing !== null) return { ok: false, reason: "trailing" };
    for (const [p, m] of staged) advise?.(p, m);
    return { ok: true, pattern, flags };
};

// {§parse-recovery} — on FIND and READ, comma-separated `/pattern/flags` literals fold into alternation.
const readRegexList = (raw: string, pos: Position, advise?: Advise): { pattern: string; flags: string } | null => {
    const items: string[] = [];
    let rest = raw;
    while (rest.length > 0) {
        if (!rest.startsWith("/") || rest.startsWith("//")) return null;
        const close = regexClose(rest);
        if (close <= 1) return null;
        const after = /^([A-Za-z]*)(.*)$/su.exec(rest.slice(close + 1));
        if (after === null) return null;
        items.push(rest.slice(0, close + 1 + after[1].length));
        const tail = after[2];
        if (tail === "") break;
        const sep = /^\s*,\s*(?=\/)/u.exec(tail);
        if (sep === null) return null;
        rest = tail.slice(sep[0].length);
    }
    if (items.length < 2) return null;
    const staged: [Position | undefined, string][] = [];
    const parsed: { pattern: string; flags: string }[] = [];
    for (const item of items) {
        const result = tryParseSlashRegex(item, pos, (p, m) => { staged.push([p, m]); });
        if (!result.ok) return null;
        parsed.push({ pattern: result.pattern, flags: result.flags });
    }
    const pattern = parsed.map((item) => `(?:${item.pattern})`).join("|");
    const flags = Array.from(new Set(parsed.map((item) => item.flags).join(""))).join("");
    try { new RegExp(pattern, flags); } catch { return null; }
    for (const [p, m] of staged) advise?.(p, m);
    advise?.(pos, `\`${raw}\` was read as the alternation \`/${pattern}/${flags}\`; a regex matcher is one \`/pattern/flags\` and selects matching lines, not the span between them.`);
    return { pattern, flags };
};

// {§matcher-prefix-claims}
export const parseMatcher = (body: string, op = "READ", pos: Position = { line: 0, column: 0 }, advise?: Advise): MatcherBody => {
    const raw = body.replace(/(?:\r\n|\r|\n)$/u, "");
    const lineCount = raw.split(/\r\n|\r|\n/u).length;
    if (lineCount !== 1) {
        return unreadable(raw, `Matcher has ${lineCount} lines; expected 1.`,
            "Write the pattern on one line.");
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
        if (op === "FIND" || op === "READ") {
            const list = readRegexList(raw, pos, advise);
            if (list !== null) return { dialect: "regex", raw, pattern: list.pattern, flags: list.flags };
        }
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
        const excerpt = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
        return unreadable(raw,
            regex.reason === "empty"
                ? "`/` opens a regex matcher but no pattern follows it; write `/pattern/flags`, flags optional."
                : `pattern leads with \`/\` but is not a valid \`/pattern/flags\` regex - ${regex.detail}${slashRecovery}: \`${excerpt}\``,
            regex.reason === "empty" ? "Write `/pattern/flags`, flags optional, such as `/timeout/i`." : REGEX_FORM);
    }
    if (raw.startsWith("$")) {
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

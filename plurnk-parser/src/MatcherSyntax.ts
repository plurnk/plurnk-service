import xpath from "xpath";
import { JSONPathEnvironment } from "json-p3";
import type { MatcherBody, Position } from "@plurnk/plurnk-contracts";

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

// {§matcher-prefix-claims} — PCRE `\A` and `\z`/`\Z` anchors normalize to `^` and `$`;
// ECMAScript `\|` remains a literal pipe `|`.
const normalizeRegexAnchors = (pattern: string): string => {
    let out = "";
    let convertedEndAnchor = false;
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === "\\" && i + 1 < pattern.length) {
            const next = pattern[i + 1];
            if (next === "A") { out += "^"; i += 1; continue; }
            if (next === "z" || next === "Z") { out += "$"; convertedEndAnchor = true; i += 1; continue; }
            out += ch + next; i += 1; continue;
        }
        out += ch;
    }
    if (convertedEndAnchor) {
        out = out.replace(/(?<!\\)\\b([A-Za-z0-9_])(?=\$)/gu, "$1");
    }
    return out;
};

// {§matcher-prefix-claims} — a `/pattern/` that fails to compile on a leading or doubled `*` or `?` and
// is otherwise glob-shaped is read as that glob over each line: `*` is `.*`, `?` is `.`.
const readGlobRegex = (inner: string, flags: string): { pattern: string; flags: string } | null => {
    if (!/^[\w*?./ -]+$/u.test(inner) || !/[*?]/u.test(inner)) return null;
    const pattern = inner.replace(/[.]/gu, "\\.").replace(/\*+/gu, ".*").replace(/\?/gu, ".");
    try { new RegExp(pattern, flags); } catch { return null; }
    return { pattern, flags };
};

// {§parse-recovery} — a leading PCRE inline modifier such as `(?i)` is the pretrained
// spelling of a flag; ECMAScript refuses the group, so it is lifted into the flags silently.
const liftInlineFlags = (pattern: string, flags: string): { pattern: string; flags: string } => {
    const inline = /^\(\?([ims]+)\)/u.exec(pattern);
    if (inline === null) return { pattern, flags };
    const lifted = Array.from(new Set(flags + inline[1])).join("");
    return { pattern: pattern.slice(inline[0].length), flags: lifted };
};

const stripLeadingTilde = (pattern: string): string => {
    if (!/^~(?=[A-Za-z0-9_"'])/u.test(pattern)) return pattern;
    return pattern.slice(1);
};

const normalizeXPathCandidate = (candidate: string): string =>
    candidate
        .replace(/^\/{3,}/u, "//")
        .replace(/\/+$/u, "")
        .replace(/(?<=\/@[A-Za-z_*][\w.:-]*)\/text\(\)/gu, "");

const tryParseEscapedSlashXPath = (raw: string): string | null => {
    if (!/^\/(?:\\\/)+[A-Za-z_*].*\/$/u.test(raw)) return null;
    if (!/(?:\\?\[@[A-Za-z_*][\w.:-]*\s*=|\\\/@[A-Za-z_*]|\\\/(?:text|node|comment|processing-instruction)\\?\(\\?\))/u.test(raw)) {
        return null;
    }
    const unescaped = raw
        .slice(1, -1)
        .replace(/\\\//gu, "/")
        .replace(/\\([[\]()])/gu, "$1");
    const normalized = normalizeXPathCandidate(unescaped.startsWith("//") ? unescaped : `//${unescaped.replace(/^\/+/u, "")}`);
    try {
        xpath.parse(normalized);
        return normalized;
    } catch {
        return null;
    }
};

const repairUnbalancedRegexDelimiters = (pattern: string): string | null => {
    if (!/[A-Za-z0-9_]/u.test(pattern)) return null;
    const toEscape = new Set<number>();
    let classOpen: number | null = null;
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === "\\") {
            i += 1;
            continue;
        }
        if (ch === "[" && classOpen === null) {
            classOpen = i;
        } else if (ch === "]" && classOpen !== null) {
            classOpen = null;
        }
    }
    if (classOpen !== null) {
        toEscape.add(classOpen);
    }
    let inClass = false;
    const openParens: number[] = [];
    for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i];
        if (ch === "\\") {
            i += 1;
            continue;
        }
        if (ch === "[" && !toEscape.has(i) && !inClass) {
            inClass = true;
            continue;
        }
        if (ch === "]" && inClass) {
            inClass = false;
            continue;
        }
        if (inClass) continue;
        if (ch === "(") {
            openParens.push(i);
        } else if (ch === ")") {
            if (openParens.length > 0) {
                openParens.pop();
            } else {
                toEscape.add(i);
            }
        }
    }
    for (const idx of openParens) {
        toEscape.add(idx);
    }
    if (toEscape.size === 0) return null;
    let out = "";
    for (let i = 0; i < pattern.length; i += 1) {
        if (toEscape.has(i)) out += "\\";
        out += pattern[i];
    }
    return out;
};

// {§parse-recovery}
const isSedRange = (raw: string): boolean =>
    /^\/(?:\\.|[^\\/])+\/[a-z]*(?:\s*,\s*(?:\/(?:\\.|[^\\/])+\/[a-z]*|[+-]?\d+)?)+$/iu.test(raw);

// {§parse-recovery} — on `edit`, a single-line `/...` snippet whose interior `/` is followed by
// non-flag literal text (such as `"/contact-us/'}index.md)"` or `"/api/v1/users"`) is literal code,
// whereas `/pattern/` with empty or letter flags stays in the regex dialect so invalid flags refuse cleanly.
export const isSlashLiteralCandidate = (raw: string): boolean => {
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.length <= 1 || isSedRange(raw)) return false;
    const close = regexClose(raw);
    if (close <= 0) return false;
    const tail = raw.slice(close + 1);
    return tail.length > 0 && !/^[ \t]*-?[A-Za-z]*[ \t]*$/u.test(tail);
};

const tryParseSlashRegex = (raw: string):
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
    if (i >= raw.length && inClass) {
        const closeMatch = /(?<!\\)\/([dgimsuvy]*)$/u.exec(raw);
        if (closeMatch !== null && closeMatch.index > 0) {
            i = closeMatch.index;
            inClass = false;
        }
    }
    if (i >= raw.length) {
        if (raw.length === 1) return { ok: false, reason: "empty" };
        const inline = liftInlineFlags(stripLeadingTilde(normalizeRegexAnchors(raw.slice(1))), "");
        try { new RegExp(inline.pattern, inline.flags); }
        catch (e) { return { ok: false, reason: "invalid", detail: detail(e), flags: inline.flags, pattern: inline.pattern }; }
        return { ok: true, pattern: inline.pattern, flags: inline.flags };
    }
    const authored = raw.slice(i + 1);
    // {§matcher-prefix-claims} — `-i` after the closing slash is the flag `i`, as a shell would take it.
    const shell = /^[\t ]*-([A-Za-z]+)[\t ]*$/u.exec(authored);
    const trailing = shell === null ? /^([A-Za-z]*)[\t ]/u.exec(authored) : null;
    const inline = liftInlineFlags(stripLeadingTilde(normalizeRegexAnchors(raw.slice(1, i))), shell?.[1] ?? trailing?.[1] ?? authored);
    let { pattern } = inline;
    const { flags } = inline;
    try { new RegExp(pattern, flags); }
    catch (e) {
        const repaired = /^[dgimsuvy]*$/u.test(flags) ? repairUnbalancedRegexDelimiters(pattern) : null;
        if (repaired === null) return { ok: false, reason: "invalid", detail: detail(e), flags, pattern };
        try { new RegExp(repaired, flags); }
        catch { return { ok: false, reason: "invalid", detail: detail(e), flags, pattern }; }
        pattern = repaired;
    }
    if (trailing !== null) return { ok: false, reason: "trailing" };
    return { ok: true, pattern, flags };
};

// {§parse-recovery} — on `find` and `read`, comma-separated `/pattern/flags` literals fold into alternation.
const readRegexList = (raw: string): { pattern: string; flags: string } | null => {
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
    const parsed: { pattern: string; flags: string }[] = [];
    for (const item of items) {
        const result = tryParseSlashRegex(item);
        if (!result.ok) return null;
        parsed.push({ pattern: result.pattern, flags: result.flags });
    }
    const pattern = parsed.map((item) => `(?:${item.pattern})`).join("|");
    const flags = Array.from(new Set(parsed.map((item) => item.flags).join(""))).join("");
    try { new RegExp(pattern, flags); } catch { return null; }
    return { pattern, flags };
};

// {§matcher-prefix-claims}
export const parseMatcher = (body: string, op = "read", _pos: Position = { line: 0, column: 0 }): MatcherBody => {
    const raw = body.replace(/(?:\r\n|\r|\n)$/u, "");
    if (/[\r\n]/u.test(raw)) {
        if (raw.startsWith("/") && !raw.startsWith("//") && /(?<!\\)\/[dgimsuvy]*$/u.test(raw)) {
            const regex = tryParseSlashRegex(raw);
            if (regex.ok) return { dialect: "regex", raw, pattern: regex.pattern, flags: regex.flags };
        }
        return { dialect: "glob", raw };
    }
    if (raw.startsWith("//")) {
        const candidate = (!raw.startsWith("///") || /^\/{3,}[^/\s].*\/$/u.test(raw))
            ? normalizeXPathCandidate(raw)
            : raw;
        try { xpath.parse(candidate); }
        catch (e) {
            const repaired = candidate.replace(/(?<=[A-Za-z0-9_*\]])@(?=[A-Za-z_*])/gu, "/@");
            if (repaired !== raw) {
                try {
                    xpath.parse(repaired);
                    return { dialect: "xpath", raw: repaired };
                } catch { /* fall through */ }
            }
            return unreadable(raw, `pattern leads with \`//\` but is not a valid xpath selector - ${detail(e)}`,
                "Write an XPath 1.0 selector after `//`, such as `//dependencies/*`.");
        }
        return { dialect: "xpath", raw: candidate };
    }
    // {§parse-recovery} — a matcher opening with `^` or closing with `$` is a regex written without slashes or flags.
    if (raw.startsWith("^") || (raw.length > 1 && !/^[/$~&]/u.test(raw) && /(?<!\\)\$$/u.test(raw))) {
        const inline = liftInlineFlags(normalizeRegexAnchors(raw.startsWith("^") ? raw.slice(1) : raw), "");
        const pattern = raw.startsWith("^") ? `^${inline.pattern}` : inline.pattern;
        try { new RegExp(pattern, inline.flags); }
        catch (e) {
            const repaired = repairUnbalancedRegexDelimiters(pattern);
            if (repaired !== null) {
                try {
                    new RegExp(repaired, inline.flags);
                    return { dialect: "regex", raw, pattern: repaired, flags: inline.flags };
                } catch { /* fall through */ }
            }
            if (!raw.startsWith("^")) return { dialect: "glob", raw };
            return unreadable(raw, `pattern leads with \`^\` but is not a valid regex - ${detail(e)}`,
                REGEX_FORM);
        }
        return { dialect: "regex", raw, pattern, flags: inline.flags };
    }
    if (raw.startsWith("/")) {
        const escapedXPath = tryParseEscapedSlashXPath(raw);
        if (escapedXPath !== null) return { dialect: "xpath", raw: escapedXPath };
        const regex = tryParseSlashRegex(raw);
        if (regex.ok) return { dialect: "regex", raw, pattern: regex.pattern, flags: regex.flags };
        if (op === "find" || op === "read") {
            const list = readRegexList(raw);
            if (list !== null) return { dialect: "regex", raw, pattern: list.pattern, flags: list.flags };
        }
        if (isSedRange(raw)) return unreadable(raw,
            "Regex matcher contains a range suffix after its closing `/`.", REGEX_FORM);
        if (regex.reason === "trailing") {
            return unreadable(raw, "Regex matcher has trailing text after `/pattern/flags`.",
                "Write only `/pattern/flags` in the matcher; flags are optional.");
        }
        if (regex.reason === "invalid") {
            const glob = readGlobRegex(regex.pattern, regex.flags);
            if (glob !== null) return { dialect: "regex", raw, pattern: glob.pattern, flags: glob.flags };
            if (
                regex.detail.includes("Invalid flags supplied")
                && !/(?<!\\)\/[dgimsuvy]*$/u.test(raw)
                && /^\/[A-Za-z_*]/u.test(raw)
                && /\/(?:@[A-Za-z_*]|[A-Za-z_*][\w.-]*\[|(?:text|node|comment|processing-instruction)\(\)|[A-Za-z_*][\w.-]*\/[A-Za-z_*@])/u.test(raw)
            ) {
                const normalized = normalizeXPathCandidate(raw);
                try {
                    xpath.parse(normalized);
                    return { dialect: "xpath", raw: normalized };
                } catch { /* fall through */ }
            }
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

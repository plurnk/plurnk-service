// {§native-tool-calls} — a model's native tool-call markup that names a plurnk operation is read
// as that operation (#760). The popular families are all read the same way: DeepSeek's DSML and
// Anthropic-style `<function_calls>` (invoke/parameter elements), the `<tool_call>` family in its
// XML-function, JSON and key/value shapes, Mistral's `[TOOL_CALLS]`, Llama's `<|python_tag|>` and
// Kimi's call sections. The intent is unambiguous when the name is a plurnk operation or a known
// executor and every parameter is one of plurnk's slots; then the block is rewritten to canonical
// fences and never taught. Any call this cannot map exactly leaves the whole input as it was.

const OPERATIONS = new Set(["FIND", "READ", "EDIT", "COPY", "MOVE", "KILL", "SEND", "NOTE", "WAIT", "BARE", "WORK", "FORK"]);
const SLOT_OF: Readonly<Record<string, "path" | "scope" | "pattern" | "aside" | "body" | "start" | "end" | "limit">> = Object.freeze({
    path: "path", target: "path", file_path: "path", filepath: "path", file: "path", filename: "path", resource: "path", uri: "path", url: "path",
    scope: "scope", range: "scope", lines: "scope",
    start: "start", start_line: "start", from: "start", offset: "start",
    end: "end", end_line: "end", to: "end",
    limit: "limit",
    pattern: "pattern", regex: "pattern", query: "pattern",
    aside: "aside",
    body: "body", content: "body", command: "body", text: "body", input: "body",
});

const DSML = "(?:｜｜DSML｜｜\\s*)?";
const INVOKE_OPEN = new RegExp(`^\\s*<${DSML}invoke\\s+name="([^"]+)"(.*)$`);
const INVOKE_CLOSE = new RegExp(`^\\s*</${DSML}invoke>\\s*$`);
const PARAMETER = new RegExp(`^\\s*<${DSML}parameter\\s+name="([^"]+)"[^>]*>(.*?)</${DSML}parameter>\\s*$`);
const STRAY_PARAMETER_CLOSE = new RegExp(`^\\s*</${DSML}parameter>\\s*$`);
const FENCE_LINE = /^\s*`{3,}\s*$/;
const MARKERS = ["DSML", "<function_calls>", "<invoke ", "<tool_call", "<function=", "[TOOL_CALLS]", "<|python_tag|>", "<|tool_call"];

type Slots = { path?: string; scope?: string; pattern?: string; aside?: string; start?: string; end?: string; limit?: string; body: string[]; extra: string };
type Call = { name: string; slots: Slots; line: number };
// A block of markup: its character span, the lines it covers, and the calls it names (null when unmappable).
type Block = { from: number; to: number; startLine: number; endLine: number; calls: Call[] | null };

export default class NativeToolCalls {
    // The lines that belong to native markup. Fence lines inside them are the markup's own, not
    // Markdown quotation.
    static markupLines(input: string): Set<number> {
        const inside = new Set<number>();
        for (const block of NativeToolCalls.#blocks(input, [])) {
            for (let line = block.startLine; line <= block.endLine; line += 1) inside.add(line);
        }
        return inside;
    }

    // Returns the rewritten input, or null when there is nothing to rewrite or any call is unmappable.
    // A block whose first line is quoted ({§quotation}) is an example, never a call.
    static rewrite(input: string, executors: readonly string[], quotedLines: ReadonlySet<number> = new Set()): string | null {
        if (!MARKERS.some((marker) => input.includes(marker))) return null;
        const blocks = NativeToolCalls.#blocks(input, executors).filter((block) => !quotedLines.has(block.startLine));
        if (blocks.length === 0) return null;
        if (blocks.some((block) => block.calls === null || block.calls.length === 0)) return null;
        let out = "";
        let cursor = 0;
        for (const block of blocks) {
            const before = input.slice(cursor, block.from);
            // Prose sharing the block's first line keeps its own line; the fences begin on a fresh one.
            out += before.length > 0 && !before.endsWith("\n") ? `${before}\n` : before;
            const span = block.endLine - block.startLine + 1;
            const fences: string[] = [];
            for (const call of block.calls!) {
                while (fences.length < call.line - block.startLine) fences.push("");
                fences.push(...NativeToolCalls.#fence(call.name, call.slots));
            }
            while (fences.length < span) fences.push("");
            out += fences.join("\n");
            const rest = input.slice(block.to);
            cursor = block.to;
            // The markup's closing line ends where it ended; text after it on the same line follows on its own line.
            if (rest.length > 0 && !rest.startsWith("\n")) out += "\n";
        }
        out += input.slice(cursor);
        return out;
    }

    // Every block of every family, in source order, with the calls it names.
    static #blocks(input: string, executors: readonly string[]): Block[] {
        const known = new Set(executors.map((name) => name.toLowerCase()));
        const lineOf = (offset: number): number => { let line = 0; for (let i = 0; i < offset && i < input.length; i += 1) if (input[i] === "\n") line += 1; return line; };
        const blocks: Block[] = [];
        let position = 0;
        while (position < input.length) {
            const found = NativeToolCalls.#next(input, position, known);
            if (found === null) break;
            if (found.calls !== null && found.calls.some((call) => !NativeToolCalls.#coherent(call.slots))) found.calls = null;
            // A block ends on the line its last character sits on; a block that ends on an empty line ends there.
            blocks.push({ ...found, startLine: lineOf(found.from), endLine: lineOf(found.to) });
            position = found.to;
        }
        return blocks;
    }

    // The earliest block at or after `position`, in whichever family it belongs to.
    static #next(input: string, position: number, known: ReadonlySet<string>): Omit<Block, "startLine" | "endLine"> | null {
        const candidates: Array<{ at: number; read: () => Omit<Block, "startLine" | "endLine"> | null }> = [];
        const at = (needle: string | RegExp): number => {
            if (typeof needle === "string") return input.indexOf(needle, position);
            const re = new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : `${needle.flags}g`);
            re.lastIndex = position;
            const m = re.exec(input);
            return m === null ? -1 : m.index;
        };
        const callsOpen = at(/<(?:｜｜DSML｜｜\s*)?(?:calls|function_calls)>/);
        if (callsOpen !== -1) candidates.push({ at: callsOpen, read: () => NativeToolCalls.#elementBlock(input, callsOpen, known) });
        const toolCall = at(/<tool_call(?:\s[^>]*)?>/);
        if (toolCall !== -1) candidates.push({ at: toolCall, read: () => NativeToolCalls.#toolCallBlock(input, toolCall, known) });
        const bareFunction = at("<function=");
        if (bareFunction !== -1) candidates.push({ at: bareFunction, read: () => NativeToolCalls.#bareFunctionBlock(input, bareFunction, known) });
        const mistral = at("[TOOL_CALLS]");
        if (mistral !== -1) candidates.push({ at: mistral, read: () => NativeToolCalls.#jsonAfter(input, mistral, "[TOOL_CALLS]".length, known) });
        const llama = at("<|python_tag|>");
        if (llama !== -1) candidates.push({ at: llama, read: () => NativeToolCalls.#jsonAfter(input, llama, "<|python_tag|>".length, known) });
        const kimi = at("<|tool_calls_section_begin|>");
        const kimiBare = at("<|tool_call_begin|>");
        const kimiAt = kimi !== -1 && (kimiBare === -1 || kimi <= kimiBare) ? kimi : kimiBare;
        if (kimiAt !== -1) candidates.push({ at: kimiAt, read: () => NativeToolCalls.#kimiBlock(input, kimiAt, known) });
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => a.at - b.at);
        // A `<function=` inside a `<tool_call>` belongs to that block; the earliest candidate owns the span.
        return candidates[0]!.read();
    }

    // DSML and Anthropic-style: `<calls>`/`<function_calls>` holding `invoke` elements with `parameter` children.
    // A block written on one line is read as if each tag had its own line.
    static #elementBlock(input: string, from: number, known: ReadonlySet<string>): Omit<Block, "startLine" | "endLine"> | null {
        const open = /<(?:｜｜DSML｜｜\s*)?(?:calls|function_calls)>/y;
        open.lastIndex = from;
        const opened = open.exec(input)!;
        const contentStart = from + opened[0].length;
        const closeRe = /<\/(?:｜｜DSML｜｜\s*)?(?:calls|function_calls)>/g;
        closeRe.lastIndex = contentStart;
        const close = closeRe.exec(input);
        const nextOpen = /<(?:｜｜DSML｜｜\s*)?(?:calls|function_calls)>/g;
        nextOpen.lastIndex = contentStart;
        const next = nextOpen.exec(input);
        const closeAt = close === null ? -1 : close.index;
        const nextAt = next === null ? -1 : next.index;
        const contentEnd = closeAt !== -1 && (nextAt === -1 || closeAt < nextAt) ? closeAt : nextAt !== -1 ? nextAt : input.length;
        // A block cut short by the next opener ends before that opener's line.
        const to = contentEnd === closeAt ? closeAt + close![0].length
            : contentEnd > from && input[contentEnd - 1] === "\n" ? contentEnd - 1 : contentEnd;
        const startLine = input.slice(0, from).split("\n").length - 1;
        const region = input.slice(contentStart, contentEnd);
        const inline = !region.includes("\n");
        const normalized = inline
            ? region.replace(/(<(?:｜｜DSML｜｜\s*)?(?:invoke|parameter)\b|<\/(?:｜｜DSML｜｜\s*)?invoke>)/g, "\n$1").replace(/(<\/(?:｜｜DSML｜｜\s*)?parameter>)/g, "$1\n")
            : region;
        const lines = normalized.split("\n");
        const calls: Call[] = [];
        let current: { name: string; slots: Slots; line: number } | null = null;
        let mappable = true;
        const finish = (): void => { if (current !== null) calls.push(current); current = null; };
        for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i]!;
            // A multi-line block's first line is the opener's own; its calls sit on the lines after it.
            const sourceLine = inline ? startLine : startLine + i;
            const invoke = INVOKE_OPEN.exec(line);
            if (invoke !== null) {
                finish();
                const name = NativeToolCalls.#operation(invoke[1]!, known);
                const slots = NativeToolCalls.#headingSlots(invoke[2]!);
                if (name === null || slots === null) { mappable = false; continue; }
                current = { name, slots, line: sourceLine };
                continue;
            }
            if (INVOKE_CLOSE.test(line) || STRAY_PARAMETER_CLOSE.test(line) || FENCE_LINE.test(line)) { finish(); continue; }
            const parameter = PARAMETER.exec(line);
            if (parameter !== null) {
                const slot = SLOT_OF[parameter[1]!];
                if (current === null || slot === undefined) { mappable = false; continue; }
                if (slot === "body") current.slots.body.push(parameter[2]!);
                else current.slots[slot] = parameter[2]!;
                continue;
            }
            if (current === null) { if (line.trim().length > 0) mappable = false; continue; }
            current.slots.body.push(line);
        }
        finish();
        return { from, to, calls: mappable ? calls : null };
    }

    // `<tool_call>…</tool_call>` in its three shapes: `<function=NAME>` with `<parameter=key>` children
    // (Qwen, MiMo), a JSON object `{"name", "arguments"}` (Hermes and kin), or a bare name followed by
    // `<arg_key>`/`<arg_value>` pairs (GLM).
    static #toolCallBlock(input: string, from: number, known: ReadonlySet<string>): Omit<Block, "startLine" | "endLine"> | null {
        const open = /<tool_call(?:\s[^>]*)?>/y;
        open.lastIndex = from;
        const opened = open.exec(input)!;
        const contentStart = from + opened[0].length;
        const close = input.indexOf("</tool_call>", contentStart);
        const nextOpen = input.indexOf("<tool_call", contentStart);
        const contentEnd = close !== -1 && (nextOpen === -1 || close < nextOpen) ? close : nextOpen !== -1 ? nextOpen : input.length;
        const to = contentEnd === close ? close + "</tool_call>".length : contentEnd;
        const content = input.slice(contentStart, contentEnd);
        const line = input.slice(0, from).split("\n").length - 1;
        const trimmed = content.trim();
        let call: Call | null;
        if (trimmed.startsWith("<function=")) call = NativeToolCalls.#functionElement(trimmed, line, known);
        else if (trimmed.startsWith("{") || trimmed.startsWith("[")) call = NativeToolCalls.#jsonCall(trimmed, line, known);
        else if (trimmed.includes("<arg_key>")) call = NativeToolCalls.#keyValueCall(trimmed, line, known);
        else call = null;
        return { from, to, calls: call === null ? null : [call] };
    }

    // A `<function=NAME …>…</function>` outside any `<tool_call>` (Llama 3.1 and kin).
    static #bareFunctionBlock(input: string, from: number, known: ReadonlySet<string>): Omit<Block, "startLine" | "endLine"> | null {
        const close = input.indexOf("</function>", from);
        const to = close === -1 ? input.length : close + "</function>".length;
        const line = input.slice(0, from).split("\n").length - 1;
        const call = NativeToolCalls.#functionElement(input.slice(from, to), line, known);
        return { from, to, calls: call === null ? null : [call] };
    }

    // `<function=NAME rest>` … `</function>`: parameters as `<parameter=key>value</parameter>` elements,
    // a JSON object as the whole content, or plain text as the body.
    static #functionElement(text: string, line: number, known: ReadonlySet<string>): Call | null {
        // The tag ends at the first `>` not owed to a `<…>` written inside it, so a plurnk scope survives.
        const headingEnd = NativeToolCalls.#tagEnd(text, "<function=".length);
        if (headingEnd === null) return null;
        const rawHeading = text.slice("<function=".length, headingEnd);
        // When the closing bracket was a scope's own, the scope keeps it.
        const unclosed = (rawHeading.match(/</g) ?? []).length > (rawHeading.match(/>/g) ?? []).length;
        const heading = (unclosed ? `${rawHeading}>` : rawHeading).trim();
        const nameEnd = heading.search(/[\s(<[]/);
        const rawName = nameEnd === -1 ? heading : heading.slice(0, nameEnd);
        const name = NativeToolCalls.#operation(rawName, known);
        const slots = NativeToolCalls.#headingSlots(nameEnd === -1 ? "" : ` ${heading.slice(nameEnd)}`, false);
        if (name === null || slots === null) return null;
        let inner = text.slice(headingEnd + 1);
        const closeAt = inner.lastIndexOf("</function>");
        if (closeAt !== -1) inner = inner.slice(0, closeAt);
        const parameters = [...inner.matchAll(/<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g)];
        if (parameters.length > 0) {
            for (const [, key, value] of parameters) {
                if (!NativeToolCalls.#assign(slots, key!.trim(), NativeToolCalls.#trimLines(value!))) return null;
            }
            const leftover = inner.replace(/<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g, "").trim();
            if (leftover.length > 0) slots.body.push(...leftover.split("\n"));
            return { name, slots, line };
        }
        const trimmed = inner.trim();
        if (trimmed.startsWith("{")) {
            const parsed = NativeToolCalls.#json(trimmed);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (!NativeToolCalls.#assign(slots, key, NativeToolCalls.#stringOf(value))) return null;
            }
            return { name, slots, line };
        }
        if (trimmed.length > 0) slots.body.push(...trimmed.split("\n"));
        return { name, slots, line };
    }

    // `{"name": "READ", "arguments": {…}}`, arguments also accepted as `parameters`, `input`, or a JSON string.
    static #jsonCall(text: string, line: number, known: ReadonlySet<string>): Call | null {
        const parsed = NativeToolCalls.#json(text);
        const record = Array.isArray(parsed) ? parsed[0] : parsed;
        if (record === null || typeof record !== "object") return null;
        return NativeToolCalls.#callFromRecord(record as Record<string, unknown>, line, known);
    }

    static #callFromRecord(record: Record<string, unknown>, line: number, known: ReadonlySet<string>): Call | null {
        const inner = record.function !== undefined && typeof record.function === "object" && record.function !== null
            ? record.function as Record<string, unknown>
            : record;
        if (typeof inner.name !== "string") return null;
        const name = NativeToolCalls.#operation(inner.name, known);
        if (name === null) return null;
        let args: unknown = inner.arguments ?? inner.parameters ?? inner.input ?? {};
        if (typeof args === "string") args = NativeToolCalls.#json(args);
        if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
        const slots: Slots = { body: [], extra: "" };
        for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
            if (!NativeToolCalls.#assign(slots, key, NativeToolCalls.#stringOf(value))) return null;
        }
        return { name, slots, line };
    }

    // GLM: the name on its own, then `<arg_key>k</arg_key><arg_value>v</arg_value>` pairs.
    static #keyValueCall(text: string, line: number, known: ReadonlySet<string>): Call | null {
        const nameEnd = text.indexOf("<arg_key>");
        const name = NativeToolCalls.#operation(text.slice(0, nameEnd).trim(), known);
        if (name === null) return null;
        const slots: Slots = { body: [], extra: "" };
        const pairs = [...text.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)];
        if (pairs.length === 0) return null;
        for (const [, key, value] of pairs) {
            if (!NativeToolCalls.#assign(slots, key!.trim(), NativeToolCalls.#trimLines(value!))) return null;
        }
        return { name, slots, line };
    }

    // A JSON value following a marker: Mistral's array after `[TOOL_CALLS]`, Llama's object after `<|python_tag|>`.
    static #jsonAfter(input: string, from: number, markerLength: number, known: ReadonlySet<string>): Omit<Block, "startLine" | "endLine"> | null {
        const start = from + markerLength;
        const valueStart = start + (input.slice(start).match(/^\s*/)?.[0].length ?? 0);
        const end = NativeToolCalls.#balancedEnd(input, valueStart);
        if (end === null) return { from, to: start, calls: null };
        const parsed = NativeToolCalls.#json(input.slice(valueStart, end));
        const records = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
        const line = input.slice(0, from).split("\n").length - 1;
        const calls: Call[] = [];
        for (const record of records) {
            if (record === null || typeof record !== "object") return { from, to: end, calls: null };
            const call = NativeToolCalls.#callFromRecord(record as Record<string, unknown>, line, known);
            if (call === null) return { from, to: end, calls: null };
            calls.push(call);
        }
        // A trailing end-of-message token belongs to the markup.
        const tail = /^\s*<\|(?:eom_id|eot_id)\|>/.exec(input.slice(end));
        return { from, to: end + (tail?.[0].length ?? 0), calls };
    }

    // Kimi: `<|tool_call_begin|>functions.READ:0<|tool_call_argument_begin|>{…}<|tool_call_end|>`, in a section or bare.
    static #kimiBlock(input: string, from: number, known: ReadonlySet<string>): Omit<Block, "startLine" | "endLine"> | null {
        const sectionEnd = input.indexOf("<|tool_calls_section_end|>", from);
        const to = sectionEnd !== -1 ? sectionEnd + "<|tool_calls_section_end|>".length
            : (() => { const last = input.lastIndexOf("<|tool_call_end|>"); return last === -1 || last < from ? input.length : last + "<|tool_call_end|>".length; })();
        const section = input.slice(from, to);
        const calls: Call[] = [];
        for (const match of section.matchAll(/<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)<\|tool_call_end\|>/g)) {
            const offset = from + (match.index ?? 0);
            const line = input.slice(0, offset).split("\n").length - 1;
            const name = NativeToolCalls.#operation(match[1]!.trim().replace(/^functions\./, "").replace(/:\d+$/, ""), known);
            if (name === null) return { from, to, calls: null };
            const args = NativeToolCalls.#json(match[2]!.trim());
            if (args === null || typeof args !== "object" || Array.isArray(args)) return { from, to, calls: null };
            const slots: Slots = { body: [], extra: "" };
            for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
                if (!NativeToolCalls.#assign(slots, key, NativeToolCalls.#stringOf(value))) return { from, to, calls: null };
            }
            calls.push({ name, slots, line });
        }
        return { from, to, calls: calls.length === 0 ? null : calls };
    }

    // A plurnk operation name, case-insensitively, or a known executor by its own spelling.
    static #operation(raw: string, known: ReadonlySet<string>): string | null {
        const name = raw.trim();
        if (OPERATIONS.has(name.toUpperCase())) return name.toUpperCase();
        return known.has(name.toLowerCase()) ? name : null;
    }

    static #assign(slots: Slots, key: string, value: string): boolean {
        const slot = SLOT_OF[key];
        if (slot === undefined) return false;
        if (slot === "body") slots.body.push(...value.split("\n"));
        else slots[slot] = value;
        return true;
    }

    // The offset of the `>` that closes a tag opened before `from`, skipping `<…>` pairs written inside it.
    static #tagEnd(text: string, from: number): number | null {
        let depth = 0;
        for (let i = from; i < text.length; i += 1) {
            const c = text[i];
            if (c === "<") depth += 1;
            else if (c === ">") {
                // A scope written last, `<function=READ (a.py) <1,-1></function>`, closes the tag with its own bracket.
                if (depth === 0 || /^(?:\s*<parameter=|\s*<\/function>|\s*$)/.test(text.slice(i + 1))) return i;
                depth -= 1;
            }
        }
        return null;
    }

    // `start`/`end` written as separate parameters are one scope; `offset`/`limit` (a first line and a
    // count, as some tool schemas spell it) likewise. A lone `end` or `limit` names no scope.
    static #scopeOf(slots: Slots): string {
        if (slots.start === undefined) return "";
        const start = slots.start.trim();
        if (slots.end !== undefined) return `<${start},${slots.end.trim()}>`;
        if (slots.limit !== undefined) {
            const first = Number(start); const count = Number(slots.limit);
            return Number.isSafeInteger(first) && Number.isSafeInteger(count) && count > 0 ? `<${first},${first + count - 1}>` : `<${start}>`;
        }
        return `<${start}>`;
    }

    static #stringOf(value: unknown): string {
        return typeof value === "string" ? value : JSON.stringify(value);
    }

    static #trimLines(value: string): string {
        return value.replace(/^\n+/, "").replace(/\n+$/, "");
    }

    static #json(text: string): unknown | null {
        try { return JSON.parse(text) as unknown; } catch { return null; }
    }

    // The end offset (exclusive) of the balanced JSON value starting at `start`, or null.
    static #balancedEnd(input: string, start: number): number | null {
        const open = input[start];
        if (open !== "{" && open !== "[") return null;
        let depth = 0; let inString = false; let escaped = false;
        for (let i = start; i < input.length; i += 1) {
            const c = input[i]!;
            if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === "\"") inString = false; continue; }
            if (c === "\"") inString = true;
            else if (c === "{" || c === "[") depth += 1;
            else if (c === "}" || c === "]") { depth -= 1; if (depth === 0) return i + 1; }
        }
        return null;
    }

    // Attributes on the invoke line (`path="…"`, `range="…"`, `aside="…"`) and any plurnk slots the
    // model wrote verbatim after the name (`(path) <scope> [{"cwd":"."}] <!-- … -->`).
    static #headingSlots(rest: string, tagClosed = true): Slots | null {
        const slots: Slots = { body: [], extra: "" };
        let remainder = tagClosed ? rest.replace(/(?<!--)\/?>\s*$/, "") : rest;
        for (const [whole, key, value] of remainder.matchAll(/\s([a-z_]+)="([^"]*)"/g)) {
            if (!NativeToolCalls.#assign(slots, key!, value!) || SLOT_OF[key!] === "body") return null;
            remainder = remainder.replace(whole, "");
        }
        slots.extra = remainder.trim();
        return slots;
    }

    // A call whose scope came as `end` or `limit` without a `start` names no scope; it is unmappable.
    static #coherent(slots: Slots): boolean {
        return slots.start !== undefined || (slots.end === undefined && slots.limit === undefined);
    }

    static #fence(name: string, slots: Slots): string[] {
        const scope = slots.scope !== undefined ? slots.scope.trim() : NativeToolCalls.#scopeOf(slots);
        const heading = [
            name,
            slots.path === undefined ? "" : `(${slots.path.trim()})`,
            scope === "" ? "" : scope.startsWith("<") ? scope : `<${scope}>`,
            slots.pattern === undefined ? "" : `[${JSON.stringify({ pattern: slots.pattern })}]`,
            slots.extra,
            slots.aside === undefined ? "" : `<!-- ${slots.aside.trim()} -->`,
        ].filter((part) => part.length > 0).join(" ");
        const longest = slots.body.reduce((max, line) => Math.max(max, /`+/.exec(line)?.[0].length ?? 0), 0);
        const fence = "`".repeat(Math.max(4, longest + 1));
        return [`${fence}${heading}`, ...slots.body, fence];
    }
}

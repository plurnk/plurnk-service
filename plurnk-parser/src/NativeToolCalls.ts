// {§native-tool-calls} — a model's native tool-call markup that names a plurnk operation is read
// as that operation (#760). DeepSeek emits `<｜｜DSML｜｜ invoke name="READ">` with parameters named
// after plurnk's own slots; the intent is unambiguous, so it is rewritten to the canonical fence and
// never taught. Each block keeps its line count, so parsed positions still point at the source.
// Any invoke this cannot map exactly (unknown name, unknown parameter) leaves the whole input as is.

const TAG = "(?:<｜｜DSML｜｜\\s*|<)";
const CALLS_OPEN = new RegExp(`^\\s*${TAG}calls>\\s*$`);
const CALLS_CLOSE = new RegExp(`^\\s*</(?:｜｜DSML｜｜\\s*)?calls>\\s*$`);
const INVOKE_OPEN = new RegExp(`^\\s*<｜｜DSML｜｜\\s*invoke\\s+name="([^"]+)"(.*)$`);
const INVOKE_CLOSE = new RegExp(`^\\s*</(?:｜｜DSML｜｜\\s*)?invoke>\\s*$`);
const PARAMETER = new RegExp(`^\\s*${TAG}parameter\\s+name="([^"]+)"[^>]*>(.*?)</(?:｜｜DSML｜｜\\s*)?parameter>\\s*$`);
const STRAY_PARAMETER_CLOSE = new RegExp(`^\\s*</(?:｜｜DSML｜｜\\s*)?parameter>\\s*$`);
const FENCE_LINE = /^\s*`{3,}\s*$/;

const OPERATIONS = new Set(["FIND", "READ", "EDIT", "COPY", "MOVE", "KILL", "SEND", "NOTE", "WAIT", "BARE", "WORK", "FORK"]);
const SLOT_OF: Readonly<Record<string, "path" | "scope" | "pattern" | "aside" | "body">> = Object.freeze({
    path: "path", target: "path",
    scope: "scope", range: "scope", lines: "scope",
    pattern: "pattern",
    aside: "aside",
    body: "body", content: "body", command: "body",
});

type Slots = { path?: string; scope?: string; pattern?: string; aside?: string; body: string[]; extra: string };

export default class NativeToolCalls {
    static readonly #MARKER = "DSML";

    // Returns the rewritten input, or null when there is nothing to rewrite or any invoke is unmappable.
    static rewrite(input: string, executors: readonly string[]): string | null {
        if (!input.includes(NativeToolCalls.#MARKER)) return null;
        const known = new Set(executors.map((name) => name.toLowerCase()));
        const lines = input.split("\n");
        const out: string[] = [];
        let rewrote = false;
        for (let i = 0; i < lines.length; i++) {
            if (!CALLS_OPEN.test(lines[i])) { out.push(lines[i]); continue; }
            const start = i;
            const fences: string[] = [];
            let current: { name: string; slots: Slots; line: number } | null = null;
            // Each fence's heading lands on its invoke's own line when the space allows.
            const finish = (): void => {
                if (current === null) return;
                while (fences.length < current.line - start) fences.push("");
                fences.push(...NativeToolCalls.#fence(current.name, current.slots));
                current = null;
            };
            let end = lines.length - 1;
            for (i = start + 1; i < lines.length; i++) {
                const line = lines[i];
                if (CALLS_CLOSE.test(line)) { end = i; break; }
                if (CALLS_OPEN.test(line)) { end = i - 1; i--; break; }
                const invoke = INVOKE_OPEN.exec(line);
                if (invoke !== null) {
                    finish();
                    const name = invoke[1];
                    const op = OPERATIONS.has(name.toUpperCase()) ? name.toUpperCase() : known.has(name.toLowerCase()) ? name : null;
                    if (op === null) return null;
                    const slots = NativeToolCalls.#headingSlots(invoke[2]);
                    if (slots === null) return null;
                    current = { name: op, slots, line: i };
                    continue;
                }
                if (INVOKE_CLOSE.test(line) || STRAY_PARAMETER_CLOSE.test(line) || FENCE_LINE.test(line)) {
                    finish();
                    continue;
                }
                const parameter = PARAMETER.exec(line);
                if (parameter !== null) {
                    const slot = SLOT_OF[parameter[1]];
                    if (current === null || slot === undefined) return null;
                    if (slot === "body") current.slots.body.push(parameter[2]);
                    else current.slots[slot] = parameter[2];
                    continue;
                }
                if (current === null) {
                    if (line.trim().length > 0) return null;
                    continue;
                }
                current.slots.body.push(line);
            }
            finish();
            if (!fences.some((line) => line.length > 0)) return null;
            const span = end - start + 1;
            out.push(...fences, ...Array.from({ length: Math.max(0, span - fences.length) }, () => ""));
            i = end;
            rewrote = true;
        }
        return rewrote ? out.join("\n") : null;
    }

    // Attributes on the invoke line (`path="…"`, `range="…"`, `aside="…"`) and any plurnk slots the
    // model wrote verbatim after the name (`[{"cwd":"."}] <!-- … -->`).
    static #headingSlots(rest: string): Slots | null {
        const slots: Slots = { body: [], extra: "" };
        let remainder = rest.replace(/(?<!--)\/?>\s*$/, "");
        for (const [whole, key, value] of remainder.matchAll(/\s([a-z]+)="([^"]*)"/g)) {
            const slot = SLOT_OF[key];
            if (slot === undefined || slot === "body") return null;
            slots[slot] = value;
            remainder = remainder.replace(whole, "");
        }
        slots.extra = remainder.trim();
        return slots;
    }

    static #fence(name: string, slots: Slots): string[] {
        const scope = slots.scope === undefined ? "" : slots.scope.trim();
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

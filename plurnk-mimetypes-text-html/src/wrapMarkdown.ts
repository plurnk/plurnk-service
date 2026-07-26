const knob = "PLURNK_MIMETYPES_HTML_WRAP_COLUMNS";

export function markdownWrapColumns(): number {
    const raw = process.env[knob];
    if (raw === undefined || raw === "") {
        throw new Error(`${knob} is required`);
    }
    const columns = Number(raw);
    if (!Number.isSafeInteger(columns) || columns < 0) {
        throw new Error(`${knob} must be 0 or a positive integer`);
    }
    return columns;
}

export function wrapMarkdown(markdown: string, columns = markdownWrapColumns()): string {
    if (columns === 0) return markdown;

    const wrapped: string[] = [];
    let fence: string | null = null;
    for (const line of markdown.split("\n")) {
        const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1] ?? null;
        if (fence !== null) {
            wrapped.push(line);
            if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
            continue;
        }
        if (marker !== null) {
            fence = marker;
            wrapped.push(line);
            continue;
        }
        if (line.length <= columns || structuralLine(line)) {
            wrapped.push(line);
            continue;
        }
        wrapped.push(...wrapLine(line, columns));
    }
    return wrapped.join("\n");
}

function structuralLine(line: string): boolean {
    const trimmed = line.trim();
    return /^#{1,6}\s/.test(trimmed)
        || trimmed.includes("|")
        || /^ {4}/.test(line);
}

function wrapLine(line: string, columns: number): string[] {
    const prefix = line.match(/^(\s*(?:(?:>\s*)+|(?:[-+*]|\d+[.)])\s+)?)/)?.[1] ?? "";
    const continuation = prefix.includes(">") ? prefix : " ".repeat(prefix.length);
    const segments: string[] = [];
    let rest = line;
    let first = true;

    while (rest.length > columns) {
        const available = columns - (first ? 0 : continuation.length);
        const boundary = breakAt(rest, Math.max(1, available));
        if (boundary === null) break;
        segments.push(`${first ? "" : continuation}${rest.slice(0, boundary).trimEnd()}`);
        rest = rest.slice(boundary).trimStart();
        first = false;
    }
    segments.push(`${first ? "" : continuation}${rest}`);
    return segments;
}

function breakAt(line: string, limit: number): number | null {
    const safe: number[] = [];
    let codeTicks = 0;
    let angle = false;
    let linkLabel = false;
    let destinationDepth = 0;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === "`" && !angle && destinationDepth === 0) {
            let run = 1;
            while (line[i + run] === "`") run++;
            if (codeTicks === 0) codeTicks = run;
            else if (run === codeTicks) codeTicks = 0;
            i += run - 1;
            continue;
        }
        if (codeTicks > 0) continue;
        if (ch === "<" && destinationDepth === 0) angle = true;
        if (angle) {
            if (ch === ">") angle = false;
            continue;
        }
        if (ch === "[" && destinationDepth === 0) linkLabel = true;
        if (linkLabel) {
            if (ch === "]") linkLabel = false;
            continue;
        }
        if (ch === "(" && i > 0 && line[i - 1] === "]") {
            destinationDepth = 1;
            continue;
        }
        if (destinationDepth > 0) {
            if (ch === "(") destinationDepth++;
            else if (ch === ")") destinationDepth--;
            continue;
        }
        if (/\s/.test(ch)) safe.push(i);
    }

    const before = safe.filter((index) => index <= limit).at(-1);
    return before ?? safe.find((index) => index > limit) ?? null;
}

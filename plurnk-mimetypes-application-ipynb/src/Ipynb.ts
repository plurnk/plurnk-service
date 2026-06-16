import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol } from "@plurnk/plurnk-mimetypes";

// application/x-ipynb+json (Jupyter notebook) handler — Tier 4, no parser dep.
//
// A .ipynb IS json, but the json IS the noise: a model that wants to read a
// notebook does not want `{"cell_type":"code","source":["import x\n",...]}`,
// it wants the narrative + code the way a reader sees it. So the load-bearing
// channel here is `content` (SPEC §18): the notebook projected to clean reading
// markdown — markdown cells verbatim, code cells fenced in the kernel language,
// text/stream/error outputs folded in, images dropped. That projection is also
// the embed-source, so a notebook's embedding reflects what it SAYS, not its
// json envelope.
//
// symbols index into that SAME projection (not the raw json): markdown headings
// become `heading` symbols (outline-nesting by level, like text-markdown), each
// code cell becomes a `module` symbol spanning its fenced block. So an outline
// of a notebook reads as its sections with their code cells nested underneath.
//
// deepJson is the parsed notebook verbatim — jsonpath/xpath reach `$.cells[*]`,
// `$.metadata.kernelspec.language`, etc. References are deferred (a notebook's
// imports/calls are kernel-language code; parsing them would mean embedding a
// per-kernel parser — out of scope for v1).
export default class Ipynb extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        const nb = safeParse(content);
        return nb ? project(nb).symbols : [];
    }

    override content(content: HandlerContent): string | undefined {
        const nb = safeParse(content);
        if (!nb) return undefined;
        const md = project(nb).markdown;
        return md.length > 0 ? md : undefined;
    }

    override deepJson(content: HandlerContent): unknown {
        return safeParse(content);
    }

    override extent(content: HandlerContent): number {
        const nb = safeParse(content);
        return nb ? countLines(project(nb).markdown) : 0;
    }

    // Strict: a malformed notebook IS a validation failure (unlike the other
    // channels, which degrade to empty per the family's error policy).
    override validate(content: HandlerContent): void {
        JSON.parse(toStr(content));
    }

    // regex/glob and embeddings run against the readable projection, not json.
    protected override toText(content: HandlerContent): string {
        const nb = safeParse(content);
        return nb ? project(nb).markdown : toStr(content);
    }
}

interface NbOutput {
    output_type?: string;
    text?: string | string[];
    data?: Record<string, unknown>;
    traceback?: string[];
}

interface NbCell {
    cell_type?: string;
    source?: string | string[];
    outputs?: NbOutput[];
    execution_count?: number | null;
}

export interface Notebook {
    cells?: NbCell[];
    metadata?: {
        kernelspec?: { language?: string };
        language_info?: { name?: string };
    };
    nbformat?: number;
}

export interface Projection {
    markdown: string;
    symbols: MimeSymbol[];
}

// Parse to a notebook object, or null on anything that isn't one — the
// degrade-not-throw policy every channel but validate() follows.
function safeParse(content: HandlerContent): Notebook | null {
    let value: unknown;
    try {
        value = JSON.parse(toStr(content));
    } catch {
        return null;
    }
    return typeof value === "object" && value !== null ? value as Notebook : null;
}

// Project a notebook to reading markdown + the symbols that index into it.
// One pass builds the markdown line buffer and records each code cell's span
// and each markdown heading's position; heading end-lines (for outline
// nesting) are resolved in a second pass over the collected headings.
export function project(nb: Notebook): Projection {
    const lang = nb.metadata?.kernelspec?.language ?? nb.metadata?.language_info?.name ?? "";
    const cells = Array.isArray(nb.cells) ? nb.cells : [];
    const lines: string[] = [];
    const headings: { line: number; level: number; name: string }[] = [];
    const codeSyms: MimeSymbol[] = [];
    let codeIndex = 0;

    for (const cell of cells) {
        const src = joinSource(cell.source);
        if (cell.cell_type === "markdown") {
            for (const l of src.split("\n")) {
                lines.push(l);
                const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
                if (m) headings.push({ line: lines.length, level: m[1].length, name: m[2].trim() });
            }
        } else if (cell.cell_type === "code") {
            codeIndex += 1;
            const start = lines.length + 1;
            lines.push("```" + lang);
            for (const l of src.split("\n")) lines.push(l);
            lines.push("```");
            const outputs = renderOutputs(cell.outputs);
            if (outputs.length > 0) {
                lines.push("");
                lines.push("_Output:_");
                lines.push("```");
                for (const l of outputs) lines.push(l);
                lines.push("```");
            }
            const ec = typeof cell.execution_count === "number" ? cell.execution_count : null;
            codeSyms.push({
                name: ec !== null ? `In[${ec}]` : `code cell ${codeIndex}`,
                kind: "module",
                line: start,
                endLine: lines.length,
            });
        } else if (cell.cell_type === "raw") {
            for (const l of src.split("\n")) lines.push(l);
        }
        lines.push("");
    }

    const docEnd = lines.length;
    const headingSyms: MimeSymbol[] = headings.map((h, i) => {
        // A heading's section runs until the next heading of equal-or-shallower
        // level (text-markdown's outline rule), so deeper headings and the code
        // cells in between nest under it via line-range containment.
        let endLine = docEnd;
        for (let j = i + 1; j < headings.length; j += 1) {
            if (headings[j].level <= h.level) { endLine = headings[j].line - 1; break; }
        }
        return { name: h.name, kind: "heading", level: h.level, line: h.line, endLine };
    });

    const symbols = [...headingSyms, ...codeSyms]
        .sort((a, b) => a.line - b.line || b.endLine - a.endLine);
    return { markdown: lines.join("\n"), symbols };
}

// Fold a code cell's outputs into readable text: stream + text/plain results +
// error tracebacks (ANSI stripped). Images / html / json payloads are dropped —
// the content channel is reading text, not a render.
function renderOutputs(outputs?: NbOutput[]): string[] {
    if (!Array.isArray(outputs)) return [];
    const out: string[] = [];
    for (const o of outputs) {
        if (o.output_type === "stream" && o.text !== undefined) {
            pushText(out, joinSource(o.text));
        } else if ((o.output_type === "execute_result" || o.output_type === "display_data") && o.data) {
            const plain = o.data["text/plain"];
            if (plain !== undefined) pushText(out, joinSource(plain as string | string[]));
        } else if (o.output_type === "error" && Array.isArray(o.traceback)) {
            for (const frame of o.traceback) pushText(out, stripAnsi(frame));
        }
    }
    return out;
}

function pushText(out: string[], text: string): void {
    for (const l of text.replace(/\n$/, "").split("\n")) out.push(l);
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;]*m/g, "");
}

// nbformat stores source/text as either a string or an array of line-strings
// (each typically carrying its own trailing newline). join("") reconstructs.
function joinSource(source: string | string[] | undefined): string {
    if (Array.isArray(source)) return source.join("");
    return typeof source === "string" ? source : "";
}

function toStr(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}

// Editor-convention line count, mirroring the framework's default extent.
function countLines(text: string): number {
    if (text.length === 0) return 0;
    let newlines = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 0x0a) newlines += 1;
    }
    return text.charCodeAt(text.length - 1) === 0x0a ? newlines : newlines + 1;
}

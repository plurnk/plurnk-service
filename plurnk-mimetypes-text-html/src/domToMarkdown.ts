// Markdown serialization over the linkedom DOM already in hand (#344) —
// replaces turndown, whose hard dependency dragged a third full DOM
// implementation (domino) into the shipped assembly. Input is always
// Readability article output or the noise-stripped body, a small closed tag
// set; unknown elements flatten to their children. Improvement over the
// GFM-less turndown: tables serialize as pipe tables instead of text runs.

type AnyNode = { nodeType: number; nodeValue: string | null; childNodes: ArrayLike<AnyNode> };
type AnyElement = AnyNode & {
    tagName: string;
    getAttribute(name: string): string | null;
    querySelectorAll(selector: string): ArrayLike<AnyElement>;
    textContent: string | null;
};

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

const isElement = (node: AnyNode): node is AnyElement => node.nodeType === ELEMENT_NODE;

// Structural characters escaped in prose so output never fabricates markdown.
const escapeInline = (text: string): string => text.replace(/([\\`*_[\]])/g, "\\$1");
// Line-start hazards escaped after block assembly (headings, quotes, lists).
const escapeLineStarts = (block: string): string =>
    block.split("\n").map((line) => line.replace(/^(\s*)([#>]|[-+]\s|\d+[.)]\s)/, (_m, pad: string, mark: string) => `${pad}\\${mark}`)).join("\n");

const collapse = (text: string): string => text.replace(/\s+/g, " ");

// A code span wrapped in one more backtick than its longest interior run.
const codeSpan = (text: string): string => {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    const pad = text.startsWith("`") || text.endsWith("`") || text.length === 0 ? " " : "";
    return `${fence}${pad}${text}${pad}${fence}`;
};

const BLOCK_TAGS = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE", "HEADER", "FOOTER", "NAV",
    "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE",
    "HR", "TABLE", "FIGURE", "FIGCAPTION", "DL", "DT", "DD", "BODY", "HTML",
]);

const hasBlockChildren = (element: AnyElement): boolean =>
    Array.from(element.childNodes).some((child) => isElement(child) && BLOCK_TAGS.has(child.tagName));

function inline(nodes: ArrayLike<AnyNode>): string {
    let out = "";
    for (const node of Array.from(nodes)) {
        if (node.nodeType === TEXT_NODE) {
            out += escapeInline(collapse(node.nodeValue ?? ""));
            continue;
        }
        if (!isElement(node)) continue;
        const children = () => inline(node.childNodes);
        switch (node.tagName) {
            case "STRONG": case "B": {
                const body = children().trim();
                out += body.length === 0 ? "" : `**${body}**`;
                break;
            }
            case "EM": case "I": {
                const body = children().trim();
                out += body.length === 0 ? "" : `*${body}*`;
                break;
            }
            case "DEL": case "S": case "STRIKE": {
                const body = children().trim();
                out += body.length === 0 ? "" : `~~${body}~~`;
                break;
            }
            case "CODE": out += codeSpan(collapse(node.textContent ?? "")); break;
            case "A": {
                const href = node.getAttribute("href") ?? "";
                const title = node.getAttribute("title");
                const suffix = title === null || title.length === 0 ? "" : ` "${title.replace(/"/g, '\\"')}"`;
                const body = children().trim();
                out += href.length === 0 || href.startsWith("javascript:")
                    ? body
                    : `[${body.length === 0 ? href : body}](${href}${suffix})`;
                break;
            }
            case "IMG": {
                const alt = collapse(node.getAttribute("alt") ?? "").trim();
                const src = node.getAttribute("src") ?? "";
                if (src.length > 0 && !src.startsWith("data:")) out += `![${escapeInline(alt)}](${src})`;
                break;
            }
            case "BR": out += "\n"; break;
            case "SCRIPT": case "STYLE": case "NOSCRIPT": case "TEMPLATE": break;
            default: out += children();
        }
    }
    return out;
}

const paragraph = (element: AnyElement): string[] => {
    const text = escapeLineStarts(inline(element.childNodes).replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim());
    return text.length === 0 ? [] : [text];
};

const listItems = (element: AnyElement, ordered: boolean): string[] => {
    const items: string[] = [];
    let index = 0;
    for (const child of Array.from(element.childNodes)) {
        if (!isElement(child) || child.tagName !== "LI") continue;
        index += 1;
        const marker = ordered ? `${index}. ` : "- ";
        const body = blocks(child.childNodes).join("\n\n").trim();
        const indented = body.split("\n").map((line, i) => i === 0 ? `${marker}${line}` : `${" ".repeat(marker.length)}${line}`).join("\n");
        items.push(indented.length === 0 ? `${marker}` : indented);
    }
    return items.length === 0 ? [] : [items.join("\n")];
};

const fenced = (element: AnyElement): string[] => {
    const codeChild = Array.from(element.childNodes).find((child) => isElement(child) && child.tagName === "CODE") as AnyElement | undefined;
    const body = (codeChild ?? element).textContent ?? "";
    const language = /language-([\w-]+)/.exec(codeChild?.getAttribute("class") ?? "")?.[1] ?? "";
    const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    return [`${fence}${language}\n${body.replace(/\n$/, "")}\n${fence}`];
};

const table = (element: AnyElement): string[] => {
    const rows: string[][] = [];
    let headerCells = 0;
    for (const row of Array.from(element.querySelectorAll("tr"))) {
        const cells = Array.from(row.querySelectorAll("th, td"))
            .map((cell) => inline(cell.childNodes).replace(/\n/g, " ").replace(/\|/g, "\\|").trim());
        if (cells.length === 0) continue;
        if (rows.length === 0) headerCells = cells.length;
        rows.push(cells);
    }
    if (rows.length === 0) return [];
    const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
    const out = [line(rows[0]!), `|${" --- |".repeat(headerCells)}`];
    for (const row of rows.slice(1)) out.push(line(row));
    return [out.join("\n")];
};

function blocks(nodes: ArrayLike<AnyNode>): string[] {
    const out: string[] = [];
    let pendingInline: AnyNode[] = [];
    const flush = () => {
        if (pendingInline.length === 0) return;
        const text = escapeLineStarts(inline(pendingInline).trim());
        if (text.length > 0) out.push(text);
        pendingInline = [];
    };
    for (const node of Array.from(nodes)) {
        if (!isElement(node) || !BLOCK_TAGS.has(node.tagName)) {
            pendingInline.push(node);
            continue;
        }
        flush();
        switch (node.tagName) {
            case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
                const depth = Number(node.tagName[1]);
                const text = inline(node.childNodes).replace(/\n/g, " ").trim();
                if (text.length > 0) out.push(`${"#".repeat(depth)} ${text}`);
                break;
            }
            case "P": case "FIGCAPTION": case "DT": case "DD": out.push(...paragraph(node)); break;
            case "UL": out.push(...listItems(node, false)); break;
            case "OL": out.push(...listItems(node, true)); break;
            case "BLOCKQUOTE": {
                const body = blocks(node.childNodes).join("\n\n");
                if (body.length > 0) out.push(body.split("\n").map((line) => line.length === 0 ? ">" : `> ${line}`).join("\n"));
                break;
            }
            case "PRE": out.push(...fenced(node)); break;
            case "HR": out.push("---"); break;
            case "TABLE": out.push(...table(node)); break;
            default:
                out.push(...(hasBlockChildren(node) ? blocks(node.childNodes) : paragraph(node)));
        }
    }
    flush();
    return out;
}

export function domToMarkdown(root: AnyElement): string {
    return blocks(root.childNodes).join("\n\n").trim();
}

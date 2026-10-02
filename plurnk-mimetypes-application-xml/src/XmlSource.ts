import { parser } from "@lezer/xml";
import { DOMParser, type Node } from "@xmldom/xmldom";
import { TextCoordinates, type TextRegion } from "@plurnk/plurnk-mimetypes";

// {§mimetype-query} — XPath owns node identity; the concrete syntax tree owns
// source extents. DOM serialization cannot recover lexical quotes or entities.
export default class XmlSource {
    readonly document;
    readonly #tree;
    readonly #coordinates: TextCoordinates;
    readonly #lineStarts: number[];
    readonly #length: number;

    constructor(content: string) {
        this.document = new DOMParser({ onError: (level, message) => {
            if (level !== "warning") throw new SyntaxError(message);
        } }).parseFromString(content, "text/xml");
        this.#tree = parser.parse(content);
        this.#coordinates = new TextCoordinates(content);
        this.#length = content.length;
        // xmldom's XML line normalization; its columns count UTF-16 code units.
        // Convert its locator back to original offsets before applying Plurnk coordinates.
        this.#lineStarts = [0, ...[...content.matchAll(/\r[\n\u0085]|[\r\n\u0085\u2028\u2029]/g)].map((match) => match.index + match[0].length)];
        // XPath 1.0 §5.7 has logical text nodes, not separate CDATA nodes.
        const pending: Node[] = [this.document];
        while (pending.length > 0) {
            const parent = pending.pop()!;
            for (let child = parent.firstChild; child !== null;) {
                const next = child.nextSibling;
                if (child.nodeType === 4) {
                    const text = this.document.createTextNode(child.nodeValue ?? "");
                    text.lineNumber = child.lineNumber;
                    text.columnNumber = child.columnNumber;
                    parent.replaceChild(text, child);
                } else if (child.nodeType === 1) pending.push(child);
                child = next;
            }
        }
        this.document.normalize();
        pending.push(this.document);
        while (pending.length > 0) {
            const parent = pending.pop()!;
            for (let child = parent.firstChild; child !== null;) {
                const next = child.nextSibling;
                if ((child.nodeType === 3 && (parent === this.document || child.nodeValue === ""))
                    || (child.nodeType === 7 && child.nodeName === "xml")) parent.removeChild(child);
                else if (child.nodeType === 1) pending.push(child);
                child = next;
            }
        }
    }

    region(node: Node): TextRegion | undefined {
        if (node.nodeType === 9) return this.#coordinates.regionFromOffsets(0, this.#length) ?? undefined;
        const { lineNumber, columnNumber } = node;
        const start = lineNumber === undefined ? undefined : this.#lineStarts[lineNumber - 1];
        if (start === undefined || columnNumber === undefined) return undefined;
        const offset = start + columnNumber - 1;
        const kind = node.nodeType === 1 ? "Element"
            : node.nodeType === 2 ? "Attribute"
                : node.nodeType === 4 ? "Cdata"
                    : node.nodeType === 7 ? "ProcessingInst"
                        : node.nodeType === 8 ? "Comment"
                            : node.nodeType === 10 ? "DoctypeDecl" : undefined;
        let syntax = this.#tree.resolveInner(offset, 1);
        const text = (name: string): boolean => name === "Text" || name === "EntityReference" || name === "CharacterReference" || name === "Cdata";
        while (kind === undefined ? node.nodeType !== 3 || !text(syntax.name) : syntax.name !== kind) {
            if (syntax.parent === null) return undefined;
            syntax = syntax.parent;
        }
        const from = syntax.from;
        let to = syntax.to;
        if (node.nodeType === 3) {
            while (syntax.nextSibling !== null && syntax.nextSibling.from === to && text(syntax.nextSibling.name)) {
                syntax = syntax.nextSibling;
                to = syntax.to;
            }
        }
        return this.#coordinates.regionFromOffsets(from, to) ?? undefined;
    }
}

import { findNodeAtLocation, type Node } from "jsonc-parser";
import { TextCoordinates, type TextRegion } from "@plurnk/plurnk-mimetypes";

// {§mimetype-query} — RFC 6901 tokens name object keys unless their parent is
// an array. Selected values retain lexical quotes, never property punctuation.
export default class JsonSource {
    readonly #tree: Node;
    readonly #coordinates: TextCoordinates;

    constructor(content: string, tree: Node) {
        this.#tree = tree;
        this.#coordinates = new TextCoordinates(content);
    }

    region(pointer: string): TextRegion | undefined {
        let node: Node | undefined = this.#tree;
        for (const token of pointer === "" ? [] : pointer.split("/").slice(1)) {
            if (node === undefined) return undefined;
            const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
            node = findNodeAtLocation(node, [node.type === "array" ? Number(key) : key]);
        }
        if (node === undefined) return undefined;
        return this.#coordinates.regionFromOffsets(node.offset, node.offset + node.length) ?? undefined;
    }

    span(pointer: string): { line: number; column: number; endLine: number; endColumn: number } | undefined {
        const region = this.region(pointer);
        return region === undefined ? undefined : {
            line: region.startLine, column: region.startColumn, endLine: region.endLine, endColumn: region.endColumn,
        };
    }
}

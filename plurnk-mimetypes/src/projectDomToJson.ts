import type { Document as XmlDocument, Element, Node as XmlNode } from "@xmldom/xmldom";
import type { TextRegion } from "@plurnk/plurnk-contracts";

function span(region: TextRegion): { line: number; endLine: number; column: number; endColumn: number } {
    return { line: region.startLine, column: region.startColumn, endLine: region.endLine, endColumn: region.endColumn };
}

// {§mimetype-query} — a projection field maps only to its own source node,
// never to an ancestor's larger region. Synthetic fields remain locator-only.
export function projectDomToJson(document: XmlDocument, regionFor: (node: XmlNode) => TextRegion | undefined): { value: unknown; regions: ReadonlyMap<string, readonly TextRegion[]> } {
    const regions = new Map<string, readonly TextRegion[]>();
    const coordinate = (node: XmlNode, pointer: string): ReturnType<typeof span> | object => {
        const region = regionFor(node);
        if (region === undefined) return {};
        regions.set(pointer, [region]);
        return span(region);
    };
    const element = (node: Element, pointer: string): Record<string, unknown> => {
        const value: Record<string, unknown> = { type: node.tagName, ...coordinate(node, pointer) };
        if (node.attributes.length > 0) {
            const attrs: Record<string, string> = Object.create(null);
            for (let index = 0; index < node.attributes.length; index += 1) {
                const attr = node.attributes.item(index)!;
                attrs[attr.name] = attr.value;
                coordinate(attr, pointer + "/attrs/" + attr.name.replace(/~/g, "~0").replace(/\//g, "~1"));
            }
            value.attrs = attrs;
        }
        const children: XmlNode[] = [];
        for (let child = node.firstChild; child !== null; child = child.nextSibling) {
            if (child.nodeType === 1 || child.nodeType === 3 || child.nodeType === 4) children.push(child);
        }
        if (children.length === 1 && children[0].nodeType !== 1) {
            value.text = children[0].nodeValue;
            coordinate(children[0], pointer + "/text");
        } else if (children.length > 0) {
            value.children = children.map((child, index) => {
                const childPath = pointer + "/children/" + index;
                if (child.nodeType === 1) return element(child as Element, childPath);
                const fields = coordinate(child, childPath);
                coordinate(child, childPath + "/text");
                return { type: "#text", text: child.nodeValue, ...fields };
            });
        }
        return value;
    };
    const root = document.documentElement;
    return {
        value: { type: "document", ...coordinate(document, ""), children: root === null ? [] : [element(root, "/children/0")] },
        regions,
    };
}

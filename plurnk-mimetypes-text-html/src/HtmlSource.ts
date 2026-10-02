import { parse, type DefaultTreeAdapterMap } from "parse5";
import { DOMImplementation, type Node as DomNode } from "@xmldom/xmldom";
import { TextCoordinates, type TextRegion } from "@plurnk/plurnk-mimetypes";

type HtmlNode = DefaultTreeAdapterMap["childNode"];

// {§mimetype-content-query} — XPath traverses the same HTML tree that owns
// source locations. Implied nodes have no source span; there is no XML reparse.
export default class HtmlSource {
    readonly tree: DefaultTreeAdapterMap["document"];
    readonly document;
    readonly #regions = new WeakMap<DomNode, TextRegion>();

    constructor(content: string) {
        this.tree = parse(content, { sourceCodeLocationInfo: true });
        const implementation = new DOMImplementation();
        this.document = implementation.createDocument(null, "", null);
        const coordinates = new TextCoordinates(content);
        const mark = (node: DomNode, location: { startOffset: number; endOffset: number } | null | undefined): void => {
            if (location === undefined || location === null) return;
            const region = coordinates.regionFromOffsets(location.startOffset, location.endOffset);
            if (region !== null) this.#regions.set(node, region);
        };
        const copy = (node: HtmlNode): DomNode => {
            let result: DomNode;
            if ("tagName" in node) {
                // XPath 1.0 unprefixed tests address ordinary HTML elements.
                const namespace = node.namespaceURI === "http://www.w3.org/1999/xhtml" ? null : node.namespaceURI;
                const element = this.document.createElementNS(namespace, node.tagName);
                for (const attr of node.attrs) {
                    const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
                    element.setAttributeNS(attr.namespace ?? null, name, attr.value);
                    mark(element.getAttributeNode(name)!, node.sourceCodeLocation?.attrs?.[name]);
                }
                for (const child of node.childNodes) element.appendChild(copy(child));
                result = element;
            } else if (node.nodeName === "#text") {
                result = this.document.createTextNode((node as DefaultTreeAdapterMap["textNode"]).value);
            } else if (node.nodeName === "#comment") {
                result = this.document.createComment((node as DefaultTreeAdapterMap["commentNode"]).data);
            } else {
                const declaration = node as DefaultTreeAdapterMap["documentType"];
                result = implementation.createDocumentType(declaration.name, declaration.publicId, declaration.systemId);
            }
            mark(result, node.sourceCodeLocation);
            return result;
        };
        for (const node of this.tree.childNodes) this.document.appendChild(copy(node));
        mark(this.document, { startOffset: 0, endOffset: content.length });
    }

    region(node: DomNode): TextRegion | undefined {
        return this.#regions.get(node);
    }
}

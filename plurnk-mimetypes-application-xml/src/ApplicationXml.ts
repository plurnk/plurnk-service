import {
    BaseHandler,
    InvalidExpressionError,
    QueryParseFailureError,
    queryJsonpathObject,
    projectDomToJson,
    serializeXpathNode,
} from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, QueryDialect, QueryMatch, TextRegion } from "@plurnk/plurnk-mimetypes";
import type { Element, Node as XmlNode } from "@xmldom/xmldom";
import * as xpath from "xpath";
import XmlSource from "./XmlSource.ts";

export default class ApplicationXml extends BaseHandler {
    override extractRaw(content: HandlerContent): MimeSymbol[] {
        const text = textOf(content);
        if (text.length === 0) return [];
        const source = new XmlSource(text);
        const root = source.document.documentElement;
        if (root === null) return [];
        const symbols: MimeSymbol[] = [];
        const append = (element: Element, name: string, kind: MimeSymbol["kind"], container?: string): void => {
            const region = source.region(element);
            if (region === undefined) return;
            symbols.push({ name, kind, ...span(region), ...(container === undefined ? {} : { container }) });
        };
        append(root, root.tagName, "module");
        for (let child = root.firstChild; child !== null; child = child.nextSibling) {
            if (child.nodeType !== 1) continue;
            const element = child as Element;
            append(element, element.getAttribute("id") || element.getAttribute("name") || element.tagName, "field", root.tagName);
        }
        return symbols;
    }

    override deepJson(content: HandlerContent): unknown {
        const text = textOf(content);
        if (text.length === 0) return null;
        const source = new XmlSource(text);
        return projectDomToJson(source.document, (node) => source.region(node)).value;
    }

    override async query(content: HandlerContent, dialect: QueryDialect, pattern: string, flags?: string): Promise<QueryMatch[]> {
        if (dialect !== "xpath" && dialect !== "jsonpath") return super.query(content, dialect, pattern, flags);
        let source: XmlSource;
        try { source = new XmlSource(textOf(content)); }
        catch (cause) { throw new QueryParseFailureError({ mimetype: this.mimetype, cause }); }
        if (dialect === "jsonpath") {
            const { value, regions } = projectDomToJson(source.document, (node) => source.region(node));
            return queryJsonpathObject(value, pattern, (pointer) => regions.get(pointer));
        }
        let result: xpath.SelectReturnType;
        try { result = xpath.select(pattern, source.document as unknown as Node); }
        catch (cause) { throw new InvalidExpressionError({ dialect, expression: pattern, cause }); }
        if (!Array.isArray(result)) return result === null || result === undefined ? [] : [{ matched: String(result), matching: pattern }];
        return result.map((node, index) => {
            const region = source.region(node as unknown as XmlNode);
            return {
                matched: serializeXpathNode(node),
                matching: result.length > 1 ? "(" + pattern + ")[" + (index + 1) + "]" : pattern,
                ...(region === undefined ? {} : { regions: [region] }),
            };
        });
    }
}

function textOf(content: HandlerContent): string {
    return typeof content === "string" ? content : new TextDecoder("utf-8").decode(content);
}

function span(region: TextRegion): { line: number; endLine: number; column: number; endColumn: number } {
    return { line: region.startLine, column: region.startColumn, endLine: region.endLine, endColumn: region.endColumn };
}

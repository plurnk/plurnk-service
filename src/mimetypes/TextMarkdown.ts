import type { MimetypeHandler } from "./_types.ts";

export default class TextMarkdown implements MimetypeHandler {
    readonly mimetype = "text/markdown";
    readonly glyph = "📝";

    validate(_content: string): void {
        // any string is valid markdown
    }

    symbols(content: string): string {
        const lines = content.split("\n");
        const headings: string[] = [];
        for (const line of lines) {
            const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
            if (match === null) continue;
            const level = match[1].length;
            const text = match[2];
            const indent = "  ".repeat(level - 1);
            headings.push(`${indent}${text}`);
        }
        return headings.join("\n");
    }

    preview(content: string, budget: number): string {
        const outline = this.symbols(content);
        const result = outline.length > 0 ? outline : content;
        return result.length <= budget ? result : result.slice(0, budget);
    }
}

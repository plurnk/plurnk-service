// text/markdown mimetype handler for plurnk-service. Implements the
// MimetypeHandler duck contract (see MIMETYPES.md in plurnk-service):
// - mimetype: string — declared mimetype identifier
// - glyph: string — single-character display marker
// - validate(content) — throw on malformed content (markdown accepts anything)
// - symbols(content) — structural outline (heading hierarchy)
// - preview(content, budget) — bounded structural view for index tiles

export default class TextMarkdown {
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

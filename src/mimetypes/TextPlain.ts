import type { MimetypeHandler } from "./_types.ts";

export default class TextPlain implements MimetypeHandler {
    readonly mimetype = "text/plain";
    readonly glyph = "📄";

    validate(_content: string): void {
        // any string is valid text/plain
    }

    symbols(_content: string): string {
        return "";
    }

    preview(content: string, budget: number): string {
        return content.length <= budget ? content : content.slice(0, budget);
    }
}

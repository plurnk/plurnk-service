// Mimetype handler contract — implemented by every bundled and external
// `@plurnk/plurnk-mimetypes-*` package. See SPEC.md §4.

export interface MimetypeHandler {
    readonly mimetype: string;
    readonly glyph: string;
    validate(content: string): void;
    symbols(content: string): string;
    preview(content: string, budget: number): string;
}

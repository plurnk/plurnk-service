# @plurnk/plurnk-mimetypes-text-markdown

`text/markdown` mimetype handler for [plurnk-service](https://github.com/plurnk/plurnk-service).

## install

```
npm i @plurnk/plurnk-mimetypes-text-markdown
```

## interface

Default export is a class implementing the plurnk mimetype handler contract (see plurnk-service `MIMETYPES.md`):

```ts
class TextMarkdown {
    readonly mimetype = "text/markdown";
    readonly glyph = "📝";
    validate(content: string): void;
    symbols(content: string): string;
    preview(content: string, budget: number): string;
}
```

`symbols` extracts an indented heading outline from the source. `preview` returns the outline (when headings exist) or the body otherwise, truncated to `budget` characters.

## license

MIT.

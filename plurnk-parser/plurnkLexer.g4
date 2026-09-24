lexer grammar plurnkLexer;

tokens {
    OPEN_FIND, OPEN_READ, OPEN_EDIT, OPEN_COPY, OPEN_MOVE,
    OPEN_SEND, OPEN_NOTE, OPEN_WAIT,
    OPEN_EXEC, OPEN_BARE, OPEN_WORK, OPEN_FORK, OPEN_KILL,
    OPEN_LOOK,
    LPAREN, RPAREN, LBRACKET, RBRACKET, L_MARKER, BODY_OPEN, SECTION_END,
    TARGET_TEXT, METADATA_TEXT, BODY_TEXT, TEXT, ASIDE
}

@lexer::members {
private openOp: string = "";
// {§executor-runtime-declaration} — the opener names a runtime rather than an operation keyword.
private execFence: boolean = false;
private openHeading: string = "";
private openHeadingLine: number = 0;
private openHeadingColumn: number = 0;
private fenceLength: number = 0;
private fenceCharacter: number = 0x60;
private openFenceStart: number = 0;
private balancedEnds: Map<number, number | null> = new Map();
private fenceLines: Array<{ start: number; width: number; character: number; tail: string } | null> | null = null;
// {§reasoning-notes} — quotations are opaque; program-boundary recovery is not note extraction.
public reasoning: boolean = false;
private started: boolean = false;
// {§inline-chain} — a closer on the heading line may be followed by the next opener on the same line.
private inlineChain: boolean = false;
// {§transparent-inline-closer} — a closer already consumed mid-heading, so the line's end closes.
private inlineCloserSeen: boolean = false;
private unclosedAsides: Array<{ line: number; column: number }> = [];

// After a closer's text, does an opener (backticks, a known name) follow on the same line?
private openerFollows(): boolean {
    let cursor = 1;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    let ticks = 0;
    while (this.inputStream.LA(cursor) === 0x60) { ticks++; cursor++; }
    if (ticks < 3) return false;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch; cursor++;
    }
    return name !== "" && (Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name));
}

private noteUnclosedAside(): void {
    this.unclosedAsides.push({ line: (this as any).currentTokenStartLine, column: (this as any).currentTokenColumn });
}

public takeUnclosedAsides(): Array<{ line: number; column: number }> {
    const taken = this.unclosedAsides;
    this.unclosedAsides = [];
    return taken;
}

private asideClosesOnLine(): boolean {
    let cursor = 1;
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0 || c === 0x0A || c === 0x0D) return false;
        if (c === 0x2D && this.inputStream.LA(cursor + 1) === 0x2D && this.inputStream.LA(cursor + 2) === 0x3E) return true;
        cursor++;
    }
}
// {§fence-heading-in-body} - tags that end an open block from inside it; the host adds executors.
public knownExecutors: Set<string> = new Set(["sh"]);
// {§executor-case} - an executor tag matches its registered name in any case (`SH` is `sh`).
private knownExecutor(name: string): boolean {
    if (this.knownExecutors.has(name)) return true;
    const lower = name.toLowerCase();
    for (const known of this.knownExecutors) if (known.toLowerCase() === lower) return true;
    return false;
}
private slotReady: boolean = false;
private targetDepth: number = 0;
private metadataDepth: number = 0;
private metadataReady: boolean = false;
private inlineBody: boolean = false;
private inlineBodies: Array<{ line: number; column: number; heading: string }> = [];
// {§bare-option-object} - true once this heading carried a [...] block.
private headingMetadata: boolean = false;
private quotedTags: Array<{ line: number; column: number; tag: string }> = [];
private quotedSpans: Array<{ start: number; end: number }> = [];
private quoteLabeled = false;
private quoteStart: number = -1;

// {§interstitial-fence} - only a native operation or a known executor opens a block.
private knownHeading(): boolean {
    const name = this.text.replace(/^\x60+/, "");
    if (this.reasoning) return name === "NOTE";
    return Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name);
}

// {§quotation} - a fence that opened no operation quotes. Its tag draws nothing: an unknown name
// is a code block at any width, and a known one indented further than three spaces is the taught
// offset ({§indented-fences}). Reasoning quotes freely.
private quote(): void {
    this.quoteStart = this.tokenStartCharIndex;
    // A labeled code block (a plurnk or md tag) is an example by declaration; only an unlabeled
    // wrapper around an operation is the mis-fence that earns a receipt ({§quotation}).
    // No literal backtick in this block: the action scanner reads one as a string delimiter.
    this.quoteLabeled = /[A-Za-z]/.test(this.text.replace(/^[\x60~]+/, ""));
    this.open();
}

// {§quotation} - an operation inside an unlabeled code block is shown, never run: the model that
// wrapped it is told so once. Labeled blocks draw nothing here.
private noteQuoted(): void {
    if (this.reasoning || this.quoteLabeled) return;
    const tag = this.text.replace(/^\x60+/, "");
    if (!(Object.hasOwn(plurnkLexer.OPERATIONS, tag) || this.knownExecutor(tag))) return;
    this.quotedTags.push({ line: (this as any).currentTokenStartLine, column: (this as any).currentTokenColumn, tag });
}

private endQuote(): void {
    if (this.quoteStart >= 0) this.quotedSpans.push({ start: this.quoteStart, end: this.inputStream.index });
    this.quoteStart = -1;
}

// The quoted character spans, the last one running to the end of the input when unclosed.
public takeQuotedSpans(length: number): Array<{ start: number; end: number }> {
    if (this.quoteStart >= 0) this.quotedSpans.push({ start: this.quoteStart, end: length });
    this.quoteStart = -1;
    const taken = this.quotedSpans;
    this.quotedSpans = [];
    return taken;
}

public takeQuotedTags(): Array<{ line: number; column: number; tag: string }> {
    const taken = this.quotedTags;
    this.quotedTags = [];
    return taken;
}

private static readonly OPERATIONS: Readonly<Record<string, number>> = {
    FIND: plurnkLexer.OPEN_FIND, READ: plurnkLexer.OPEN_READ,
    EDIT: plurnkLexer.OPEN_EDIT, COPY: plurnkLexer.OPEN_COPY, MOVE: plurnkLexer.OPEN_MOVE,
    SEND: plurnkLexer.OPEN_SEND, BARE: plurnkLexer.OPEN_BARE,
    NOTE: plurnkLexer.OPEN_NOTE, WAIT: plurnkLexer.OPEN_WAIT,
    WORK: plurnkLexer.OPEN_WORK, FORK: plurnkLexer.OPEN_FORK, KILL: plurnkLexer.OPEN_KILL,
    LOOK: plurnkLexer.OPEN_LOOK,
};

// {§naked-operation} - a native operation's name alone on a column-zero line: the next run of
// capitals is a known operation and nothing but horizontal whitespace follows it on the line.
private nakedHeadingAhead(): boolean {
    let name = "";
    for (let cursor = 1; ; cursor++) {
        const c = this.inputStream.LA(cursor);
        if (c >= 0x41 && c <= 0x5A) { name += String.fromCharCode(c); continue; }
        const after = this.skipHorizontal(cursor);
        const end = this.inputStream.LA(after);
        return Object.hasOwn(plurnkLexer.OPERATIONS, name) && (end <= 0 || end === 0x0A || end === 0x0D);
    }
}

// The naked block opens as if fenced with the taught three backticks.
private openNaked(): void {
    this.open(this.text);
    this.fenceLength = 3;
    this.fenceCharacter = 0x60;
    this.naked = true;
}

// {§naked-operation} - the name alone again, on its own line outside any nested block, closes the
// naked block it opened.
private nakedCloserAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    if (after === null || this.balancedEnd() !== null) return false;
    for (let index = 0; index < this.openOp.length; index++) {
        if (this.inputStream.LA(after + index) !== this.openOp.charCodeAt(index)) return false;
    }
    const end = this.inputStream.LA(this.skipHorizontal(after + this.openOp.length));
    return end <= 0 || end === 0x0A || end === 0x0D;
}

private naked: boolean = false;

private open(implicitName?: string): void {
    this.naked = false;
    this.headingMetadata = false;
    this.fenceLength = 0;
    this.fenceCharacter = this.text.charCodeAt(0);
    while (this.text.charCodeAt(this.fenceLength) === this.fenceCharacter) this.fenceLength++;
    const name = implicitName ?? this.text.slice(this.fenceLength);
    const native = Object.hasOwn(plurnkLexer.OPERATIONS, name) ? plurnkLexer.OPERATIONS[name] : undefined;
    this.openOp = name;
    this.execFence = native === undefined;
    this.type = native ?? plurnkLexer.OPEN_EXEC;
    this.inlineChain = false;
    this.inlineCloserSeen = false;
    this.openHeading = this.text;
    this.openFenceStart = this.tokenStartCharIndex;
    this.openHeadingLine = (this as any).currentTokenStartLine;
    this.openHeadingColumn = (this as any).currentTokenColumn;
    this.started = true;
    this.slotReady = true;
    this.metadataReady = this.execFence || this.openOp === "SEND" || this.openOp === "WAIT";
    this.inlineBody = false;
}

// {§quotation} - the line above this one carries a fence run of three or more backticks anywhere
// (a heading, a closer, or a heading written mid-line that opened nothing).
private previousLineIsFence(): boolean {
    let back = 1;
    while (this.inputStream.LA(-back) === 0x20 || this.inputStream.LA(-back) === 0x09) back++;
    if (this.inputStream.LA(-back) !== 0x0A) return false;
    back++;
    if (this.inputStream.LA(-back) === 0x0D) back++;
    let run = 0;
    for (let c = this.inputStream.LA(-back); c > 0 && c !== 0x0A; c = this.inputStream.LA(-(++back))) {
        run = c === 0x60 ? run + 1 : 0;
        if (run >= 3) return true;
    }
    return false;
}

// {§quotation} CommonMark: a backtick fence's info string cannot contain a backtick, so a line
// like ```KILL (x)``` is inline code, not an opener, and quotes nothing after it.
private fenceOpens(): boolean {
    let cursor = 1;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    if (this.inputStream.LA(cursor) !== 0x60) return true;
    while (this.inputStream.LA(cursor) === 0x60) cursor++;
    for (let c = this.inputStream.LA(cursor); c > 0 && c !== 0x0A && c !== 0x0D; c = this.inputStream.LA(++cursor)) {
        if (c === 0x60) return false;
    }
    return true;
}

// The orphaned closer is a whole line: nothing but the fence follows it.
private orphanAtLineEnd(): boolean {
    const c = this.inputStream.LA(1);
    return c <= 0 || c === 0x0A || c === 0x0D;
}

// {§naked-operation} - the name follows a newline directly, or begins the input.
private atColumnZero(): boolean {
    const c = this.inputStream.LA(-1);
    return c <= 0 || c === 0x0A || c === 0x0D;
}

// {§indented-fences} - a fence line may follow at most three spaces (CommonMark); four or more,
// or a tab, make it indented code: neither an opener, a closer nor a heading.
private atLineStart(): boolean {
    let spaces = 0;
    for (let back = 1; ; back++) {
        const c = this.inputStream.LA(-back);
        if (c <= 0 || c === 0x0A || c === 0x0D) return spaces <= 3;
        if (c !== 0x20) return false;
        spaces++;
    }
}

// {§indented-fences} - the offset of the fence run at or after this offset when its line indents it
// by at most three spaces; null when four or more, or a tab, make the line indented code. Off the
// line start (a closer on the heading line) indentation is not in question.
private fenceIndent(offset: number): number | null {
    let spaces = 0;
    let tab = false;
    for (let index = offset - 1; ; index--) {
        const c = this.inputStream.LA(index >= 1 ? index : index - 1);
        if (c <= 0 || c === 0x0A || c === 0x0D) break;
        if (c !== 0x20 && c !== 0x09) return this.skipHorizontal(offset);
        if (c === 0x09) tab = true; else spaces++;
    }
    for (;; offset++) {
        const c = this.inputStream.LA(offset);
        if (c !== 0x20 && c !== 0x09) return tab || spaces > 3 ? null : offset;
        if (c === 0x09) tab = true; else spaces++;
    }
}

private skipHorizontal(offset: number): number {
    while (this.inputStream.LA(offset) === 0x20 || this.inputStream.LA(offset) === 0x09) offset++;
    return offset;
}

private offsetAfterEol(offset: number): number | null {
    if (this.inputStream.LA(offset) === 0x0D && this.inputStream.LA(offset + 1) === 0x0A) return offset + 2;
    return this.inputStream.LA(offset) === 0x0A ? offset + 1 : null;
}

// {§balanced-fences} — retain complete nested blocks before trying local missing-closer
// recovery. Cache descendants as well as the root so an unclosed prefix is scanned once.
private balancedEnd(): number | null {
    if (this.balancedEnds.has(this.openFenceStart)) return this.balancedEnds.get(this.openFenceStart)!;
    if (this.fenceLines === null) {
        let start = 0;
        this.fenceLines = this.inputStream.toString().split("\n").map((line) => {
            // {§indented-fences} - four spaces or a tab make the line indented code, not a fence.
            const match = /^( {0,3})(\x60{3,}|~{3,})(.*?)[ \t\r]*$/u.exec(line);
            const fence = match === null ? null : {
                start: start + match[1].length,
                width: match[2].length,
                character: match[2].charCodeAt(0),
                tail: match[3],
            };
            // ANTLR indexes Unicode code points, not JavaScript UTF-16 units.
            start += [...line].length + 1;
            return fence;
        });
    }
    // {§naked-operation} - a naked block has no closer, so nothing balances it; its nested blocks still do.
    const stack = [{ start: this.openFenceStart, width: this.naked ? Infinity : this.fenceLength, character: this.fenceCharacter }];
    for (let index = this.openHeadingLine; index < this.fenceLines.length; index++) {
        const fence = this.fenceLines[index];
        if (fence === null) continue;
        const continuation = this.continuedFence(fence);
        const closes = fence.tail === "" || continuation !== null ? this.closedBy(stack, fence) : -1;
        if (closes !== -1) {
            const [closed] = stack.splice(closes);
            this.balancedEnds.set(closed.start, fence.start);
            if (stack.length === 0) return fence.start;
            if (continuation !== null) {
                const nested = this.nestedFence(continuation);
                if (nested !== null) stack.push(nested);
            }
            continue;
        }
        if (fence.tail.trim() === "") continue;
        const nested = this.nestedFence(fence);
        if (nested !== null) stack.push(nested);
    }
    for (const fence of stack) this.balancedEnds.set(fence.start, null);
    return null;
}

// {§balanced-fences} - a bare fence closes the innermost open block of exactly its width, else the
// outermost block narrower than it; the narrower blocks it steps over are body, and a wider or
// differently fenced block inside blocks it.
private closedBy(stack: ReadonlyArray<{ width: number; character: number }>, fence: { width: number; character: number }): number {
    const exact = stack.findLastIndex((block) => block.character === fence.character && block.width === fence.width);
    const index = exact !== -1 ? exact : stack.findIndex((block) => block.character === fence.character && block.width < fence.width);
    if (index === -1) return -1;
    const blocked = stack.slice(index + 1).some((block) => block.character !== fence.character || block.width > fence.width);
    return blocked ? -1 : index;
}

private continuedFence(fence: { start: number; width: number; tail: string }): { start: number; width: number; character: number; tail: string } | null {
    const match = /^([ \t]*)(\x60{3,})([A-Za-z0-9_.+-]+)(.*)$/u.exec(fence.tail);
    if (match === null || !Object.hasOwn(plurnkLexer.OPERATIONS, match[3]) && !this.knownExecutor(match[3])) return null;
    return { start: fence.start + fence.width + match[1].length, width: match[2].length, character: 0x60, tail: match[3] + match[4] };
}

private nestedFence(fence: { start: number; width: number; character: number; tail: string }): { start: number; width: number; character: number } | null {
    if (!/[\x60~]{3}/u.test(fence.tail)) return fence;
    const name = /^[A-Za-z0-9_.+-]+/u.exec(fence.tail)?.[0];
    if (name === undefined) return fence;
    // Reuse the heading lexer: fences quoted in a target, metadata or aside are not closers.
    // Literal examples need only a lexical boundary; their slot diagnostics stay opaque.
    const lexer = new plurnkLexer(antlr.CharStream.fromString(String.fromCharCode(fence.character).repeat(fence.width) + fence.tail + "\n"));
    lexer.knownExecutors = new Set([...this.knownExecutors, name]);
    lexer.reasoning = fence.character !== 0x60;
    lexer.removeErrorListeners();
    let closed = false;
    for (let token = lexer.nextToken(); token.type !== Token.EOF; token = lexer.nextToken()) {
        if (token.type === plurnkLexer.SECTION_END && token.text?.includes("\x60")) closed = true;
    }
    if (lexer.mode === plurnkLexer.DEFAULT_MODE && (closed || lexer.inlineCloserSeen)) return null;
    return { start: fence.start + lexer.openFenceStart, width: lexer.fenceLength, character: lexer.fenceCharacter };
}

// {§fence-closer} - a closer is a line of at least the opener's backticks and nothing else, within
// three spaces of the line start ({§indented-fences}); {§balanced-fences} claims nested closers first.
private closingAt(offset: number): boolean {
    if (this.naked || this.inputStream.LA(offset === 1 ? -1 : offset - 1) === this.fenceCharacter) return false;
    const fence = this.fenceIndent(offset);
    if (fence === null) return false;
    offset = fence;
    if ((this.mode === plurnkLexer.BODY || this.mode === plurnkLexer.QUOTATION) && !(this.inlineBody && offset === 1)) {
        const end = this.balancedEnd();
        if (end !== null && this.inputStream.index + offset - 1 !== end) return false;
    }
    let cursor = offset;
    while (this.inputStream.LA(cursor) === this.fenceCharacter) cursor++;
    if (cursor - offset < this.fenceLength) return false;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    if (this.inputStream.LA(cursor) <= 0 || this.offsetAfterEol(cursor) !== null) return true;
    if (this.reasoning) return false;
    // {§closer-aside} — a closer followed on its line by one aside and nothing else still closes;
    // read as body, that line would be written into the edited resource (#758, dogfood item 17).
    if (this.asideToLineEnd(cursor)) return true;
    // {§inline-chain} — a closer followed on its line by the next opener still closes.
    let ticks = 0;
    while (this.inputStream.LA(cursor + ticks) === 0x60) ticks++;
    if (ticks < 3) return false;
    let at = cursor + ticks;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(at);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch; at++;
    }
    return name !== "" && (Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name));
}

// {§fence-heading-in-body} — a known heading of the taught width recovers an unclosed block only
// after {§balanced-fences} has ruled out complete nesting: a wider block holds narrower headings
// only while it closes, so no unclosed block swallows the operations after it.
private headingAt(offset: number): boolean {
    if (this.reasoning) return false;
    let cursor = offset;
    while (this.inputStream.LA(cursor) === 0x60) cursor++;
    if (cursor - offset < 3) return false;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0) break;
        const ch = String.fromCharCode(c);
        if (!/[A-Za-z0-9_.+-]/.test(ch)) break;
        name += ch;
        cursor++;
    }
    if (name === "") return false;
    if (!Object.hasOwn(plurnkLexer.OPERATIONS, name) && !this.knownExecutor(name)) return false;
    const next = this.inputStream.LA(cursor);
    return next <= 0 || next === 0x20 || next === 0x09 || next === 0x28 || next === 0x3C || next === 0x5B
        || this.offsetAfterEol(cursor) !== null;
}

private headingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    const at = after === null ? null : this.fenceIndent(after);
    return at !== null && this.balancedEnd() === null && this.headingAt(at);
}

// `<!-- … -->` at this offset, then only horizontal whitespace to the end of the line or input.
private asideToLineEnd(at: number): boolean {
    const open = [0x3C, 0x21, 0x2D, 0x2D];
    if (!open.every((code, index) => this.inputStream.LA(at + index) === code)) return false;
    let cursor = at + open.length;
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0 || c === 0x0A || c === 0x0D) return false;
        if (c === 0x2D && this.inputStream.LA(cursor + 1) === 0x2D && this.inputStream.LA(cursor + 2) === 0x3E) break;
        cursor++;
    }
    cursor += 3;
    while (this.inputStream.LA(cursor) === 0x20 || this.inputStream.LA(cursor) === 0x09) cursor++;
    return this.inputStream.LA(cursor) <= 0 || this.offsetAfterEol(cursor) !== null;
}

private closingAfterEol(): boolean {
    const after = this.offsetAfterEol(1);
    return after !== null && this.closingAt(after);
}

// {§transparent-inline-closer} — true when the run here closes the open block but more of the
// heading follows on the line and it is not the next opener. Slots, matchers, asides and option
// blocks all still belong to this heading, so the closer is skipped and reading continues.
private closerWithHeadingAhead(): boolean {
    if (this.inputStream.LA(-1) === 0x60) return false;
    let cursor = 1;
    let ticks = 0;
    while (this.inputStream.LA(cursor + ticks) === 0x60) ticks++;
    if (ticks < this.fenceLength) return false;
    let at = cursor + ticks;
    while (this.inputStream.LA(at) === 0x20 || this.inputStream.LA(at) === 0x09) at++;
    // End of line or input: the ordinary closer owns it.
    if (this.inputStream.LA(at) <= 0 || this.offsetAfterEol(at) !== null) return false;
    // The next opener on the line: {§inline-chain} owns it.
    return !this.openerFollowsAt(at);
}

// Does an opener (backticks, a known name) begin at this offset?
private openerFollowsAt(at: number): boolean {
    let ticks = 0;
    while (this.inputStream.LA(at + ticks) === 0x60) ticks++;
    if (ticks < 3) return false;
    let cursor = at + ticks;
    let name = "";
    for (;;) {
        const c = this.inputStream.LA(cursor);
        if (c <= 0 || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x28 || c === 0x3c || c === 0x5b || c === 0x60) break;
        name += String.fromCharCode(c);
        cursor++;
    }
    return Object.hasOwn(plurnkLexer.OPERATIONS, name) || this.knownExecutor(name);
}

private targetScopeEnd(): boolean {
    let offset = 1;
    while (this.inputStream.LA(offset) === 0x20 || this.inputStream.LA(offset) === 0x09) offset++;
    return this.targetDepth === 0 && this.inputStream.LA(offset) === 0x29;
}

private inlineBodyAhead(): boolean {
    const previous = this.inputStream.LA(-1);
    return previous === 0x20 || previous === 0x09;
}

private noteInlineBody(): void {
    this.inlineBody = true;
    // {§naked-pattern} - a sigil is a matcher on any heading, and every heading-line word on FIND,
    // READ or KILL is one, so only a bodied operation's stray heading text is worth an advisory.
    const first = this.text.charCodeAt(0) === 0x60 ? this.inputStream.LA(1) : this.text.charCodeAt(0);
    if (first === 0x2F || first === 0x24 || first === 0x7E || first === 0x26 || first === 0x5E) return;
    if (this.openOp === "FIND" || this.openOp === "READ" || this.openOp === "KILL") return;
    // {§bare-option-object} - one JSON object where the option block goes is the option block: the
    // builder lifts it, and its receipt stands in for this advisory.
    if (first === 0x7B && this.bareOptionObjectOnLine()) return;
    this.inlineBodies.push({ line: this.getOpenTagLine(), column: this.getOpenTagColumn(), heading: this.getOpenHeading() });
}

private bareOptionObjectOnLine(): boolean {
    if (this.headingMetadata || this.text.charCodeAt(0) === 0x60) return false;
    if (!(this.execFence || this.openOp === "SEND" || this.openOp === "BARE" || this.openOp === "WORK" || this.openOp === "FORK")) return false;
    let rest = this.text;
    for (let offset = 1; ; offset++) {
        const c = this.inputStream.LA(offset);
        if (c <= 0 || c === 0x0A || c === 0x0D) break;
        rest += String.fromCodePoint(c);
    }
    // a closing fence on the heading line is not part of the object
    const fence = rest.lastIndexOf("\x60\x60\x60");
    if (fence !== -1 && rest.slice(fence).replace(/[\x60 \t]/gu, "") === "") rest = rest.slice(0, fence);
    rest = rest.trim();
    let parsed: unknown;
    try { parsed = JSON.parse(rest); } catch { return false; }
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
}

public takeInlineBodies(): Array<{ line: number; column: number; heading: string }> {
    const taken = this.inlineBodies;
    this.inlineBodies = [];
    return taken;
}

public getOpenTag(): string { return this.openOp; }
public getOpenOp(): string { return this.openOp; }
public isExecFence(): boolean { return this.execFence; }
public getOpenTagLine(): number { return this.openHeadingLine; }
public getOpenTagColumn(): number { return this.openHeadingColumn; }
public getOpenHeading(): string { return this.openHeading; }
public getFenceLength(): number { return this.fenceLength; }

public isTextCoordinateOp(): boolean {
    return this.openOp === "READ" || this.openOp === "EDIT" || this.openOp === "COPY" || this.openOp === "MOVE"
        || this.openOp === "KILL" || this.openOp === "LOOK";
}
}

// {§operation-fences} - three or more backticks open an operation; three is the taught width.
fragment FENCE : '```' '`'* ;
fragment NAME : [A-Za-z0-9_.+-]+ ;
fragment NUM : '-'? [0-9]+ ('.' [0-9]+)? ;
fragment L_PATTERN : '<' NUM (('-' | ',' ' '?) NUM)* '>' ;
fragment LINE_ANCHOR : '@' [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] [0-9A-Za-z] ;
// {§anchor-digits} — `@` with one to four digits cannot be a hash: it is read as that line.
fragment DIGIT_ANCHOR : '@' [0-9] [0-9]? [0-9]? [0-9]? ;
// {§anchor-offset} — `@abcde+1` and a bare `+1` after an anchor are tolerated, never taught (#749).
fragment ANCHOR_OFFSET : LINE_ANCHOR [+-] [0-9]+ ;
fragment RELATIVE_COORD : '+' [0-9]+ ;
fragment TEXT_COORD : NUM | ANCHOR_OFFSET | LINE_ANCHOR | DIGIT_ANCHOR | RELATIVE_COORD ;
fragment TEXT_L_PATTERN : '<' TEXT_COORD (',' ' '? TEXT_COORD)* '>' ;
fragment COMBINED_LINE_COORD : LINE_ANCHOR (':' | ' ') [1-9] [0-9]* ;
fragment COMBINED_TEXT_COORD : TEXT_COORD | COMBINED_LINE_COORD ;
fragment COMBINED_TEXT_L_PATTERN : '<' COMBINED_TEXT_COORD (',' ' '? COMBINED_TEXT_COORD)* '>' ;
fragment EOL : '\r'? '\n' ;

// {§fence-boundary} - only top-level fences can open statements. The first
// block may terminate a provider preamble without an intervening newline.
OPEN : { this.atLineStart() || !this.reasoning && this.inlineChain }? FENCE NAME { this.knownHeading() }? { this.open(); } -> mode(SLOTS) ;
// {§naked-operation} - the name alone on a column-zero line opens the operation without a fence.
NAKED_OPEN : { this.atColumnZero() && !this.reasoning && this.nakedHeadingAhead() }? [A-Z]+ { this.openNaked(); } -> mode(SLOTS) ;
// {§reasoning-notes} — an enclosing code fence is quotation, including unknown tags and tildes.
// {§quotation} - a bare fence directly under a fence line is that block's orphaned closer: it
// closes nothing and quotes nothing (a malformed heading's block ends at its own line).
ORPHAN_CLOSER : { this.atLineStart() && this.previousLineIsFence() }? FENCE [ \t]* { this.orphanAtLineEnd() }? -> channel(HIDDEN) ;
// {§quotation} - every other fence at a line start quotes to its closer or the end of the input.
// A line-start fence whose line carries more backticks is inline code: it quotes nothing.
INLINE_TAG : { this.atLineStart() && !this.fenceOpens() }? FENCE NAME -> type(TEXT), channel(HIDDEN) ;
QUOTE : { this.atLineStart() && this.fenceOpens() }? (FENCE NAME? | '~~~' '~'* NAME?) { this.quote(); } -> type(TEXT), channel(HIDDEN), mode(QUOTATION) ;
// {§interstitial-fence} - a fence naming nothing known, or nothing at all, is prose outside a block.
WS : [ \t\r\n]+ -> channel(HIDDEN) ;
// {§whitespace-contract} - outside text has no AST or execution semantics.
// {§provider-tagged-reasoning} - a route that delivers reasoning inline declares it, and the
// provider peels that one leading envelope. Here a reasoning tag is prose: no rule in this mode
// crosses a line start unanchored, so no substring found in text can re-read the program after it.
TEXT_RUN : ~[ \t\r\n`]+ { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;
TEXT_TICK : '`' { this.inlineChain = false; } -> type(TEXT), channel(HIDDEN) ;

// {§parser-architecture} - the modes below are that chapter's state diagram: DEFAULT, QUOTATION,
// SLOTS, TARGET, METADATA and BODY, and each `mode(...)` action is one of its edges.
mode QUOTATION;
Q_END : { this.closingAfterEol() }? EOL [ \t]* ('```' '`'* | '~~~' '~'*) [ \t]* { this.endQuote(); } -> type(TEXT), channel(HIDDEN), mode(DEFAULT_MODE) ;
Q_EMPTY_END : { this.atLineStart() && this.closingAt(1) }? [ \t]* ('```' '`'* | '~~~' '~'*) [ \t]* { this.endQuote(); } -> type(TEXT), channel(HIDDEN), mode(DEFAULT_MODE) ;
Q_TAG : { this.atLineStart() }? FENCE NAME { this.noteQuoted(); } -> type(TEXT), channel(HIDDEN) ;
Q_RUN : ~[\r\n`~]+ -> type(TEXT), channel(HIDDEN) ;
Q_CHAR : . -> type(TEXT), channel(HIDDEN) ;

mode SLOTS;
// {§one-line-turn} - the next opener on a heading's own line ends this bodyless block and opens.
SLOTS_NEXT_OPENER : { this.slotReady && this.openerFollows() }? [ \t]+ { this.inlineChain = true; } -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_WS : [ \t]+ { this.slotReady = true; } -> skip ;
// {§heading-slot-order} — zero-width characters on a heading line are invisible to the writer too (#758).
SLOTS_INVISIBLE : [\u200B-\u200D\u2060\uFEFF]+ -> skip ;
SLOTS_LPAREN : { this.slotReady }? '(' { this.targetDepth = 0; this.metadataReady = false; } -> type(LPAREN), mode(TARGET) ;
SLOTS_LBRACKET : { this.slotReady && this.metadataReady }? '[' { this.metadataDepth = 0; } -> type(LBRACKET), mode(METADATA) ;
// {§send-wait-scope} — whatever a WAIT names in its scope slot is skipped unread, never refused
// (#756): the park needs no selection. An aside (`<!--`) is not a scope.
SLOTS_WAIT_SCOPE : { this.slotReady && this.openOp === "WAIT" }? '<' (~[!\r\n>] ~[\r\n>]*)? '>' -> skip ;
SLOTS_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_L : { this.slotReady }? L_PATTERN -> type(L_MARKER) ;
// {§combined-anchor-tolerance} — `<@abcde 42>` is the anchor with its displayed line number; the builder drops the number.
SLOTS_COMBINED_TEXT_L : { this.slotReady && this.isTextCoordinateOp() }? COMBINED_TEXT_L_PATTERN -> type(L_MARKER) ;
SLOTS_ASIDE : { this.slotReady }? '<!--' ~[\r\n]*? '-->' -> type(ASIDE) ;
// {§unclosed-aside} — an aside that never closes on its line is the aside to the end of the line.
SLOTS_ASIDE_OPEN : { this.slotReady && !this.asideClosesOnLine() }? '<!--' ~[\r\n]* { this.noteUnclosedAside(); } -> type(ASIDE) ;
// {§transparent-inline-closer} — a closing fence with more heading on its line reads as if it
// were not written: the slots after it still belong to this operation (operator, 2026-09-13:
// "If there's no risk of ambiguity, then we add tolerance").
SLOTS_INLINE_CLOSER : { this.slotReady && this.closerWithHeadingAhead() }? FENCE [ \t]* { this.inlineCloserSeen = true; } -> skip ;
SLOTS_END : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_INLINE_BODY : { this.slotReady && this.inlineBodyAhead() }? ~[ \t\r\n[(<`] { this.noteInlineBody(); } -> type(BODY_TEXT), mode(BODY) ;
// {§heading-slot-order} — a single backtick before a matcher sigil quotes that matcher, never a fence (#758).
SLOTS_TICK_TEXT : { this.slotReady && this.inlineBodyAhead() && [0x2F, 0x24, 0x7E, 0x26, 0x5E].includes(this.inputStream.LA(2)) }? '`' { this.noteInlineBody(); } -> type(BODY_TEXT), mode(BODY) ;
// {§transparent-inline-closer} — the block already met its closer, so its line ending ends it.
SLOTS_CLOSED_EOL : { this.inlineCloserSeen }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_NEXT_HEADING : { this.headingAfterEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
SLOTS_BODY_OPEN : EOL -> type(BODY_OPEN), mode(BODY) ;

mode TARGET;
TARGET_FENCE : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
// An unclosed slot ends with its heading line: the statement is one bounded error and the next
// line lexes fresh, so siblings survive ({§closer-fallback}); only EOF inside the slot is a tail.
TARGET_BODY_OPEN : EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
TARGET_ESCAPE : '\\' ('\\' | '(' | ')') -> type(TARGET_TEXT) ;
TARGET_INNER : ~[\\()<`\r\n]+ -> type(TARGET_TEXT) ;
TARGET_BACKSLASH : '\\' -> type(TARGET_TEXT) ;
TARGET_NEST_OPEN : '(' { this.targetDepth++; } -> type(TARGET_TEXT) ;
TARGET_NEST_END : { this.targetDepth > 0 }? ')' { this.targetDepth--; } -> type(TARGET_TEXT) ;
TARGET_TEXT_SCOPE : { this.isTextCoordinateOp() }? TEXT_L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_SCOPE : { this.openOp === "FIND" || this.execFence || this.openOp === "SEND" }? L_PATTERN { this.targetScopeEnd() }? -> type(L_MARKER) ;
TARGET_TICK : '`' -> type(TARGET_TEXT) ;
TARGET_END : ')' { this.slotReady = true; this.metadataReady = true; } -> type(RPAREN), mode(SLOTS) ;

mode METADATA;
METADATA_FENCE : { this.closingAt(1) }? FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
METADATA_BODY_OPEN : EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
METADATA_STRING : '"' ('\\' ~[\r\n] | ~["\\\r\n])* '"' -> type(METADATA_TEXT) ;
METADATA_INNER : ~[[\]"`\r\n]+ -> type(METADATA_TEXT) ;
METADATA_TICK : '`' -> type(METADATA_TEXT) ;
METADATA_QUOTE : '"' -> type(METADATA_TEXT) ;
METADATA_NEST_OPEN : '[' { this.metadataDepth++; } -> type(METADATA_TEXT) ;
METADATA_NEST_END : { this.metadataDepth > 0 }? ']' { this.metadataDepth--; } -> type(METADATA_TEXT) ;
METADATA_END : ']' { this.slotReady = true; this.metadataReady = true; this.headingMetadata = true; } -> type(RBRACKET), mode(SLOTS) ;

mode BODY;
// {§fence-closer} the block's own closer; {§fence-heading-in-body} a heading ends it instead, and
// the EOL becomes a synthetic SECTION_END whose text carries no backtick ({§closer-fallback}).
B_END : { this.closingAfterEol() }? EOL [ \t]* FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_EMPTY_END : { (this.atLineStart() || this.inlineBody) && this.closingAt(1) }? [ \t]* FENCE [ \t]* { this.inlineChain = this.openerFollows(); } -> type(SECTION_END), mode(DEFAULT_MODE) ;
// {§transparent-inline-closer} — the heading already carried its closer, so the matcher or inline
// body after it ends with that line and the block never reaches for the next operation.
B_CLOSED_EOL : { this.inlineCloserSeen }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
// {§naked-operation} - a naked block also closes at its own name alone on a line.
B_NAKED_END : { this.naked && this.nakedCloserAfterEol() }? EOL [ \t]* [A-Z]+ [ \t]* -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_NEXT_HEADING : { this.headingAfterEol() }? EOL -> type(SECTION_END), mode(DEFAULT_MODE) ;
B_RUN : ~[\r\n`]+ -> type(BODY_TEXT) ;
B_TICK : '`' -> type(BODY_TEXT) ;
B_CRLF : '\r\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_LF : '\n' { this.inlineBody = false; } -> type(BODY_TEXT) ;
B_CR : '\r' -> type(BODY_TEXT) ;

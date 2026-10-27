// {§application-session-observation} A message as a list shows it: its first line holding anything but blanks, at most `chars` characters
// with blanks trimmed from their end, never a character cut in two; `continued` when anything but blanks follows.
// Blanks are spaces, tabs and line ends.
const BLANK = new Set([" ", "\t", "\r", "\n"]);

export const excerptOf = (text: string, chars: number): { readonly excerpt: string; readonly continued: boolean } => {
    let at = 0;
    while (at < text.length && BLANK.has(text[at] ?? "")) at++;
    const lineEnd = text.indexOf("\n", at);
    const end = lineEnd < 0 ? text.length : lineEnd;
    // `chars` characters span at most twice as many UTF-16 units.
    const excerpt = Array.from(text.slice(at, Math.min(end, at + chars * 2))).slice(0, chars).join("").replace(/[ \t\r]+$/u, "");
    return { excerpt, continued: /[^ \t\r\n]/u.test(text.slice(at + excerpt.length)) };
};

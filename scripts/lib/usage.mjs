// {§script-help} — the one usage seam every named entry point shares: `--help` (or `-h`) prints the
// text and exits 0 before the script does anything else. The text's first line is `usage: …`, then what
// the script does, then `Reads:` (environment and files it consults) and `Writes:` (what it produces).
export const usage = (meta, text) => {
    if (!meta.main) return;
    if (!process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) return;
    process.stdout.write(`${text.trim()}\n`);
    process.exit(0);
};

export interface ScriptReceipt {
    scheme: string;
    pathname: string | null;
    fragment: string | null;
    tx: string;
    rx: string | null;
    attrs: string;
    status_rx: number;
    origin: string;
}

// Match an executed artifact to its observed terminal output, not the final
// answer's repetition of a marker already present in the prompt.
export const observedScriptExecution = (
    executions: ScriptReceipt[], reads: ScriptReceipt[], filename: string, marker: string,
): boolean => executions.some((execution) => {
    if (execution.origin !== "model" || execution.status_rx !== 200) return false;
    const statement = JSON.parse(execution.tx);
    const body = typeof statement.body === "string" ? statement.body : statement.body?.raw ?? "";
    if (!`${statement.target?.raw ?? ""}\n${body}`.includes(filename)) return false;
    const stream: unknown = JSON.parse(execution.attrs).stream;
    if (typeof stream !== "string") return false;
    const address = new URL(stream);
    return reads.some((read) => {
        if (read.status_rx !== 200 || read.rx === null) return false;
        const attrs = JSON.parse(read.attrs);
        const result = JSON.parse(read.rx);
        return read.scheme === address.protocol.slice(0, -1) && read.pathname === address.pathname
            && read.fragment === "stdout" && attrs.terminal === true
            && result.exitCode === 0 && result.content?.trim() === marker;
    });
});

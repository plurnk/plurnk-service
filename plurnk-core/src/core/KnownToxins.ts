// {§response-text-note} — storing interstitial text is a privilege, not a right (operator,
// 2026-09-23). A span is the model's NOTE only when its turn executed at least one operation and
// the span itself is narration: not a foreign tool-call grammar or leaked template token that a
// model emits when it loses the plot. (An operation written outside its fence never reaches here:
// the parser keeps that line out of response text, {§unfenced-operation}.)
// Anything else echoed back as a log item feeds the next turn the very grammar that broke this
// one. The exact emission stays readable at the turn's own address (ops://<worker>/<loop>/<turn>).
// Mechanism, not a knob: literal registers, extended as digests show new shapes.
const MARKERS: readonly string[] = Object.freeze([
    "<｜｜DSML｜｜",        // DeepSeek V4 tool-call markup, as emitted in the text channel
    "<|DSML|>",
    "<tool_call>",           // Qwen, Hermes and kin
    "<|tool_call|>",
    "<function_calls>",      // Anthropic-style
    "<invoke name=",
    "[TOOL_CALLS]",          // Mistral
    "<|python_tag|>",        // Llama
    "<|im_start|>",          // ChatML template leak
    "<｜begin▁of▁sentence｜>", // DeepSeek template leak
]);

export default class KnownToxins {
    // The first marker the text carries, or null when it carries none.
    static match(text: string): string | null {
        return MARKERS.find((marker) => text.includes(marker)) ?? null;
    }

    // Whether a text span earns a NOTE on a turn that executed `operations` operations.
    static retains(text: string, operations: number): boolean {
        return operations > 0 && KnownToxins.match(text) === null;
    }
}

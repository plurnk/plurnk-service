// {§response-text-note}: exclude foreign tool-call grammar and leaked template tokens from
// retained prose. The parser owns operation boundaries ({§response-text}).
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

    static retains(text: string): boolean {
        return KnownToxins.match(text) === null;
    }
}

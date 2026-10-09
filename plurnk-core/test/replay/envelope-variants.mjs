// Recorded-text experiment only (#1043). Production projection uses stored section roles.
export function previousAssistantEnvelope(messages) {
    if (messages.map(({ role }) => role).join(",") !== "system,user"
        || messages.some(({ content }) => typeof content !== "string")) {
        throw new TypeError("previous-assistant requires a recorded system + user text envelope");
    }
    const user = messages[1].content;
    const separator = "\n\n## Previous Emission\n\n";
    const previousAt = user.indexOf(separator);
    if (previousAt < 0) return messages;
    if (previousAt !== user.lastIndexOf(separator)) throw new Error("ambiguous recorded Previous Emission boundary");
    const footerAt = user.lastIndexOf("\n\n## Worker\n", previousAt);
    if (footerAt < 0) throw new Error("recorded previous emission has no Worker footer boundary");
    return [
        messages[0],
        { role: "user", content: user.slice(0, footerAt) },
        { role: "assistant", content: user.slice(previousAt + separator.length) },
        { role: "user", content: user.slice(footerAt + 2, previousAt) },
    ];
}

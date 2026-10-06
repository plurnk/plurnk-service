// ARCHITECTURE.md § Extension vocabulary — every retired form of the extension vocabulary is refused
// by name with its successor, across every tracked text file. A line that must quote a retired form,
// such as a setting's shed, carries `lexicon-allow` (#1009).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const TAGS = [
    "plugin-attribution", "plugin-trust-boundary", "plugin-manifest-read", "http-materializer-plugins",
    "plugin-discovery", "plugin-namespace-arbitration", "plugin-family-kind", "default-plugin-ownership",
    "packet-plugin-transform", "core-plugin-composition", "mimetype-plugin-failure",
];
const GRAMMAR_TAGS = [
    "mimetype-grammar-leaves", "grammar-leaf-reproducibility", "grammar-family-lifecycle",
    "mimetype-grammar-extensions", "grammar-extension-reproducibility",
];
// A kind's package or framework, never a family: a family is one of core's six-verb managers.
const KIND_WORDS = "exec|executor|scheme|schemes|mimetype|mimetypes|provider|providers|module|grammar|materializer|subprocess|reader|native";

export const RETIRED = [
    { label: "retired setting", re: /PLURNK_PLUGINS_TRUSTED_ONLY/u, successor: "PLURNK_EXTENSIONS_TRUSTED_ONLY" },
    { label: "retired setting", re: /PLURNK_MIMETYPES_FAMILY_ROOT/u, successor: "PLURNK_MIMETYPES_PACKAGES_ROOT" },
    { label: "retired diagnostic family", re: /native-plugins/u, successor: "the `extensions` family" },
    { label: "retired specification tag", re: new RegExp(`§(?:${TAGS.join("|")})(?![a-z-])`, "u"), successor: "its `extension-*` tag" },
    { label: "retired specification tag", re: new RegExp(`§(?:${GRAMMAR_TAGS.join("|")})(?![a-z-])`, "u"), successor: "its `grammar-package` tag" },
    { label: "retired identifier", re: /\b(?:PLUGIN_KINDS|PluginKind|PluginAttribution\w*|MimetypePluginError|isPluginError|AiSdkProviderPlugin|pluginsNodeModules|RuntimesHook)\b/u, successor: "its Extension-named successor" },
    { label: "retired identifier", re: /\b(?:assertGrammarLeafContract|admitLeafForUpdate|probeLeaf|updateLeaf|makeLeaf|expectedGrammarLeaves|resolveGrammarExtensions|makeFamily|familytool)\b/u, successor: "its grammar-, package- or registry-named successor" },
    { label: "plugin for native code", re: /\b(?:scheme|exec|executor|provider|mimetype|module|native|capability|materializer|grammar|handler)[- ]plugins?\b/iu, successor: "\"<kind> extension\"" },
    { label: "plugin for native code", re: /\bplugin[- ](?:code|imports?|contracts?|kinds?|famil(?:y|ies)|seams?)\b(?!=)/iu, successor: "\"extension\"" },
    { label: "Plurnk Plugin", re: /\bPlurnk Plugins?\b/u, successor: "\"Plurnk extension\"" },
    { label: "redundant qualifier", re: /\bnative extensions?\b/iu, successor: "\"extension\"" },
    { label: "capability package", re: /\bcapability[- ](?:packages?|frameworks?|famil(?:y|ies)|librar(?:y|ies))\b/iu, successor: "\"extension package\", \"framework\" or \"kind\"" },
    { label: "grammar extension", re: /\bgrammar[- ]extensions?\b/iu, successor: "\"grammar package\": a grammar declares no kind" },
    // "leaves" is often the verb ("a default leaves inspection available"), so an object after it is not a package;
    // an executor leaf is also a log coordinate's last segment, so only the plural names packages there.
    { label: "package-sense leaf", re: /\b(?:grammar|subprocess|scheme|mimetype|provider|default|optional|installed|third-party|specialized|wasm)[- ]leaf\b|\b(?:grammar|executor|exec|subprocess|scheme|mimetype|provider|default|optional|installed|third-party|specialized|wasm)[- ]leaves\b(?! (?:its|the|a|an|one|client|every|no|nothing|that|this|them|it|only)\b)/iu, successor: "\"extension\", \"executor\" or \"grammar package\"" },
    { label: "package-sense leaf", re: /\bleaf[- ](?:consumers?|sets?|packages?|workspaces?|checkouts?|lock|artifacts?)\b/iu, successor: "\"extension\", \"workspace\" or \"package\"" },
    { label: "family for a kind", re: new RegExp(`\\b(?:${KIND_WORDS})[- ]famil(?:y|ies)\\b|\\bfamily[- ](?:claims?|loaders?|packages?|roots?|inventory|maintenance)\\b|\\bfamilyRoot\\b`, "iu"), successor: "the kind, its framework or its packages; a family is one of core's six-verb managers" },
    { label: "family for a runtime", re: /\b(?:tool|executable|runtime|fence)[- ]famil(?:y|ies)\b|\bfamily[- ](?:documents?|docs?|orientation|level|paths?|summar(?:y|ies))\b|\bfamily(?:Doc|Contract|Catalog|Invocations)\b/iu, successor: "\"runtime\" or \"runtime document\"; a family is one of core's six-verb managers" },
    { label: "family for a Problem table", re: /\bthis family mints\b/iu, successor: "\"Every code minted here\"" },
    { label: "hook for a function", re: /\b(?:module|daemon|malformed) lifecycle hooks?\b|\bruntimes?[- ]hooks?\b|\b(?:discovery|executable|attribution)[- ]hooks?\b|\bdynamic-hook\b/iu, successor: "\"lifecycle member\" or \"function\"; a hook is the operator's command" },
];

export const vocabularyViolations = (file, text) => text.split("\n").flatMap((line, index) => {
    if (line.includes("lexicon-allow")) return [];
    return RETIRED.filter(({ re }) => re.test(line)).map(({ label, successor }) => `${file}:${index + 1} [${label}] → ${successor}`);
});

if (import.meta.main) {
    const root = path.resolve(import.meta.dirname, "..");
    const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n")
        .filter((file) => file !== "" && /\.(?:ts|mts|mjs|js|json|jsonc|md|g4|sql|ya?ml|sh|txt)$|\.env\.defaults$|\.env\.test$/u.test(file))
        .filter((file) => !/(?:^|\/)CHANGELOG\.md$|(?:^|\/)package-lock\.json$|^scripts\/vocabulary-policy(?:\.test)?\.mjs$/u.test(file));
    const violations = files.flatMap((file) => vocabularyViolations(file, readFileSync(path.join(root, file), "utf8")));
    if (violations.length > 0) {
        console.error(`Extension vocabulary violations (ARCHITECTURE.md § Extension vocabulary):\n  ${violations.join("\n  ")}`);
        process.exit(1);
    }
    console.log(`extension vocabulary OK: ${files.length} files`);
}

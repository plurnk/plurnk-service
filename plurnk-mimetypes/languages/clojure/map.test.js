import { testLanguage } from "../../lib/testutil.js";

await testLanguage("clojure", {
	examplesDir: "vendor/grammars-v4/clojure/examples",
	extensions: [".clj", ".cljs", ".cljc", ".edn", ".txt"],
});

import { testLanguage } from "../../lib/testutil.js";

await testLanguage("erlang", {
	examplesDir: "vendor/grammars-v4/erlang/examples",
	extensions: [".erl"],
});

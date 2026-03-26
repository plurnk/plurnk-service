import { testLanguage } from "../../lib/testutil.js";

await testLanguage("lua", {
	examplesDir: "vendor/grammars-v4/lua/examples",
	extensions: [".lua"],
	maxFiles: 50,
});

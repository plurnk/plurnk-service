import { testLanguage } from "../../lib/testutil.js";

await testLanguage("python--python3", {
	examplesDir: "vendor/grammars-v4/python/python/examples",
	extensions: [".py"],
});

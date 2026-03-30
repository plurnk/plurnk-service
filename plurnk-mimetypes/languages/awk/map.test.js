import { testLanguage } from "../../lib/testutil.js";

await testLanguage("awk", {
	examplesDir: "vendor/grammars-v4/awk/examples",
	extensions: [".awk"],
});

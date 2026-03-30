import { testLanguage } from "../../lib/testutil.js";

await testLanguage("matlab", {
	examplesDir: "vendor/grammars-v4/matlab/examples",
	extensions: [".m"],
});

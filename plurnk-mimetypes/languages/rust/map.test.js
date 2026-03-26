import { testLanguage } from "../../lib/testutil.js";

await testLanguage("rust", {
	examplesDir: "vendor/grammars-v4/rust/examples",
	extensions: [".rs"],
});

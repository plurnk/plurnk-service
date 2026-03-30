import { testLanguage } from "../../lib/testutil.js";

await testLanguage("toml", {
	examplesDir: "vendor/grammars-v4/toml/examples",
	extensions: [".toml"],
});

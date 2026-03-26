import { testLanguage } from "../../lib/testutil.js";

await testLanguage("php", {
	examplesDir: "vendor/grammars-v4/php/examples",
	extensions: [".php"],
});

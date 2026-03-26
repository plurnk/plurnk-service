import { testLanguage } from "../../lib/testutil.js";

await testLanguage("golang", {
	examplesDir: "vendor/grammars-v4/golang/examples",
	extensions: [".go"],
});

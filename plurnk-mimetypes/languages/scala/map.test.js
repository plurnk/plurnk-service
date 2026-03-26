import { testLanguage } from "../../lib/testutil.js";

await testLanguage("scala", {
	examplesDir: "vendor/grammars-v4/scala/examples",
	extensions: [".scala"],
});

import { testLanguage } from "../../lib/testutil.js";

await testLanguage("fortran", {
	examplesDir: "vendor/grammars-v4/fortran/fortran90/examples",
	extensions: [".f90", ".f"],
});

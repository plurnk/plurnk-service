// SqlRite custom-function adapter for the one model-independent ruler.
// The filename deliberately owns the SQL function name `ruler_count`;
// deterministic marks the pure function as safe for SQLite optimization.
import { rulerCount } from "./token-ruler.ts";

export const deterministic = true;
export default rulerCount;

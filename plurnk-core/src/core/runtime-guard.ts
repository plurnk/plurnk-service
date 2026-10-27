// {§startup-admission} — the executable imports this module first, so the check runs before any other
// module of the service evaluates.
import { refuseBelowFloor } from "./runtime-floor.ts";

refuseBelowFloor("plurnk-service");

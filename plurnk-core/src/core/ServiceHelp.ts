import { resolve } from "node:path";
import Paths from "../Paths.ts";
import EnvFlags, { type FlagDescriptor } from "./EnvFlags.ts";

// {§operator-config-precedence} — executable help and packaged shell/manual projections share this source.
export default class ServiceHelp {
    static async flags(): Promise<FlagDescriptor[]> {
        return [
            ...await EnvFlags.parseEnvDefaults(resolve(Paths.packageRoot, ".env.defaults")),
            ...await EnvFlags.parseEnvDefaults(Paths.sharedDefaults),
        ];
    }

    static format(flags: FlagDescriptor[]): string {
        return `usage: plurnk-service [options] [start|stop|migrate|update]
       plurnk-service [options] config [edit|defaults|check]
       plurnk-service [options] share [<file.db>] [<folder>] [--workspace=<id>] [--requiem]
       plurnk-service [options] requiem <file.db> <folder>

${EnvFlags.formatFlagsHelp(flags)}

  --env-file=<path>            layer env from <path> (repeatable; later wins; errors if missing)
  --env-file-if-exists=<path>  layer env from <path> if present (repeatable; later wins)
  --config=<path>              layer additional env from <path>
  stop                         stop the service that holds the configured database, and wait for it to exit
  update                       update the cached model catalog and installed packages (requires PLURNK_SERVICE_UPDATEABLE=1)
  config defaults             print every installed package's annotated .env.defaults
  config check                validate configuration without contacting a provider
  share                        share a consistent copy of the database as a digest <folder>
                               (default database: the service's; default folder: a stamped child
                               of PLURNK_SERVICE_SHARE_FOLDER); --workspace=<id> limits it to one
                               workspace; --requiem adds the forensic interview (calls a model)
  requiem                      add the forensic interview to a digest <folder> of <file.db> (calls a model)
  -v, --version                show executable provenance
  -h, --help                   show this help
`;
    }
}

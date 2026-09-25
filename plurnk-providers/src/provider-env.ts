export const providerEnvPrefix = (provider: string): string =>
    provider.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();

export const providerSetting = (provider: string, env: NodeJS.ProcessEnv, suffix: string): [string, string | undefined] => {
    const routeKey = `PLURNK_PROVIDERS_${suffix}`;
    const providerKey = `PLURNK_PROVIDERS_PROVIDER_${providerEnvPrefix(provider)}_${suffix}`;
    const key = env[routeKey] === undefined ? providerKey : routeKey;
    return [key, env[key]];
};

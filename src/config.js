export function loadConfig(env = process.env) {
  for (const key of ['DISCORD_TOKEN', 'CLIENT_ID']) {
    if (!env[key]) throw new Error(`Missing environment variable ${key}`);
  }
  return {
    token: env.DISCORD_TOKEN,
    clientId: env.CLIENT_ID,
    devGuildId: env.DEV_GUILD_ID || null,
    databaseUrl: env.DATABASE_URL || 'postgres://bot:bot@localhost:5432/bot',
  };
}

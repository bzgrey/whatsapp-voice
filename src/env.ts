/** Secrets and paths from .env. Behaviour settings live in config.yaml. */
export const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  OPENAI_PROJECT_ID: process.env.OPENAI_PROJECT_ID ?? '',
  OPENAI_WEBHOOK_SECRET: process.env.OPENAI_WEBHOOK_SECRET ?? '',
  PORT: Number(process.env.PORT ?? 3000),
  PAIRING_PHONE: process.env.PAIRING_PHONE ?? '',
  DB_PATH: process.env.DB_PATH ?? 'messages.db',
  CONFIG_PATH: process.env.CONFIG_PATH ?? 'config.yaml',
  AUTH_DIR: process.env.AUTH_DIR ?? 'auth_session',
};

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Messages older than this are deleted and can't be recalled (SPEC §3.6, §10.8). */
export const RETENTION_SECONDS = 4 * 24 * 3600;

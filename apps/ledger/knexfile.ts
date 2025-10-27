import { buildKnexConfig } from './src/knexConfig';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://127.0.0.1:5432/ledger';

export default {
  development: buildKnexConfig(databaseUrl),
  production: buildKnexConfig(databaseUrl),
};

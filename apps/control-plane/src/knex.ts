import knex from 'knex';
import { buildKnexConfig } from './knexConfig.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to initialize Knex');
}

const knexConfig = buildKnexConfig(databaseUrl);
const db = knex(knexConfig);

export default db;

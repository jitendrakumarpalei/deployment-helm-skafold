import knexFactory from 'knex';
import type { Knex } from 'knex';
import { buildKnexConfig as buildControlPlaneKnexConfig } from '../../apps/control-plane/src/knexConfig';
import { buildKnexConfig as buildLedgerKnexConfig } from '../../apps/ledger/src/knexConfig';

type ConfigBuilder = (databaseUrl: string) => Knex.Config;

async function runSeedsWithBuilder(builder: ConfigBuilder, databaseUrl: string): Promise<void> {
  const db = knexFactory(builder(databaseUrl));
  try {
    await db.seed.run();
  } finally {
    await db.destroy();
  }
}

export async function runControlPlaneSeeds(databaseUrl: string): Promise<void> {
  await runSeedsWithBuilder(buildControlPlaneKnexConfig, databaseUrl);
}

export async function runLedgerSeeds(databaseUrl: string): Promise<void> {
  await runSeedsWithBuilder(buildLedgerKnexConfig, databaseUrl);
}

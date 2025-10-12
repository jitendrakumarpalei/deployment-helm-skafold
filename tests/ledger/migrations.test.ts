import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../apps/ledger/src/migrate';

let container: PostgreSqlContainer | undefined;
let connectionString: string;

async function resetDatabase(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await client.end();
}

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    connectionString = process.env.TEST_DATABASE_URL;
  } else {
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('stringcost_test')
      .withUsername('stringcost')
      .withPassword('stringcost')
      .start();
    connectionString = container.getConnectionUri();
  }

  process.env.DATABASE_URL = connectionString;
  await resetDatabase(connectionString);
  await runMigrations({ databaseUrl: connectionString });
}, 180_000);

afterAll(async () => {
  if (container) {
    await container.stop();
  }
});

describe('Database migrations', () => {
  it('creates ledger tables and supports inserts', async () => {
    const client = new Client({ connectionString });
    await client.connect();

    const billingInfo = await client.query(
      `INSERT INTO billing_info(stripe_customer_id, country_code, vat_registered)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ['cus_test_123', 'US', false]
    );

    const billingInfoId = billingInfo.rows[0].id as string;

    const project = await client.query(
      `INSERT INTO project(name, billing_info_id)
       VALUES ($1, $2)
       RETURNING id`,
      ['Demo Project', billingInfoId]
    );

    const projectId = project.rows[0].id as string;

    const eventInsert = await client.query(
      `INSERT INTO ledger_events(run_id, user_id, outcome)
       VALUES ($1, $2, $3)
       RETURNING action_type, revenue_billed_micros`,
      ['2b241d5e-4879-4a35-9863-7a6a38ddf9af', 'user_123', 'success']
    );

    expect(eventInsert.rows[0].action_type).toBe('unknown');
    expect(eventInsert.rows[0].revenue_billed_micros).toBe('0');

    const rate = await client.query(
      `INSERT INTO billing_rate(
         resource_type, resource_family, location, unit_price, unit_name, effective_from
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      ['llm_tokens', 'gpt4', 'us', 0.001, 'token', new Date()]
    );

    const rateId = rate.rows[0].id as string;

    await client.query(
      `INSERT INTO billing_record(project_id, resource_id, resource_name, span, billing_rate_id, amount)
       VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6, $7)` ,
      [
        projectId,
        'f6f4864e-c8ce-4bf8-8f9b-13f35b4d8f2d',
        'Primary Endpoint',
        new Date('2025-01-01T00:00:00Z'),
        new Date('2025-01-02T00:00:00Z'),
        rateId,
        123.456
      ]
    );

    await expect(
      client.query(
        `INSERT INTO billing_record(project_id, resource_id, resource_name, span, billing_rate_id, amount)
         VALUES ($1, $2, $3, tstzrange($4, $5, '[)'), $6, $7)` ,
        [
          projectId,
          'f6f4864e-c8ce-4bf8-8f9b-13f35b4d8f2d',
          'Primary Endpoint',
          new Date('2025-01-01T12:00:00Z'),
          new Date('2025-01-02T12:00:00Z'),
          rateId,
          10
        ]
      )
    ).rejects.toThrow(/billing_record_no_overlap/);

    await client.end();
  });
});

/**
 * Initial schema setup for the ledger.
 *
 * This migration is safe to run as it only creates new tables and does not
 * modify existing data. All `notNullable` columns have default values.
 */
export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "btree_gist"');

  await knex.schema.createTable('billing_info', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('stripe_customer_id').notNullable().unique();
    table.text('country_code');
    table.text('tax_id');
    table.boolean('vat_registered').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('project', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.uuid('billing_info_id').references('id').inTable('billing_info').onDelete('SET NULL');
    table.decimal('credit', 12, 6).notNullable().defaultTo(0);
    table.integer('discount_pct').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('payment_method', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('billing_info_id').notNullable().references('id').inTable('billing_info').onDelete('CASCADE');
    table.text('stripe_payment_method_id').notNullable().unique();
    table.text('brand');
    table.text('last4');
    table.integer('exp_month');
    table.integer('exp_year');
    table.decimal('preauth_amount', 12, 6);
    table.text('preauth_intent_id');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('billing_rate', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('resource_type').notNullable();
    table.text('resource_family');
    table.text('location');
    table.decimal('unit_price', 12, 6).notNullable();
    table.text('unit_name').notNullable();
    table.timestamp('effective_from', { useTz: true }).notNullable();
    table.timestamp('effective_to', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('ledger_events', (table) => {
    table.uuid('event_id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('run_id').notNullable();
    table.text('user_id').notNullable();
    table.timestamp('timestamp', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('step_name');
    table.text('action_type').notNullable().defaultTo('unknown');
    table.text('outcome').notNullable();
    table.integer('duration_ms');
    table.bigInteger('cost_cogs_micros').notNullable().defaultTo(0);
    table.bigInteger('revenue_billed_micros').notNullable().defaultTo(0);
    table.jsonb('metadata');

    table.index(['run_id'], 'idx_ledger_events_run_id');
  });

  await knex.schema.createTable('billing_record', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('project_id').notNullable().references('id').inTable('project').onDelete('CASCADE');
    table.uuid('resource_id').notNullable();
    table.text('resource_name');
    table.specificType('span', 'tstzrange').notNullable();
    table.uuid('billing_rate_id').references('id').inTable('billing_rate').onDelete('SET NULL');
    table.decimal('amount', 12, 6).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['project_id'], 'idx_billing_record_project_id');
    table.index(['billing_rate_id'], 'idx_billing_record_rate_id');
    table.index(['resource_id'], 'idx_billing_record_resource_id');
  });

  await knex.schema.createTable('invoice', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('project_id').notNullable().references('id').inTable('project').onDelete('CASCADE');
    table.timestamp('begin_time', { useTz: true }).notNullable();
    table.timestamp('end_time', { useTz: true }).notNullable();
    table.text('invoice_number').notNullable().unique();
    table.text('status').notNullable();
    table.jsonb('content');
    table.decimal('subtotal', 12, 6).notNullable().defaultTo(0);
    table.decimal('tax', 12, 6).notNullable().defaultTo(0);
    table.decimal('total', 12, 6).notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw(
    `ALTER TABLE billing_record
       ADD CONSTRAINT billing_record_no_overlap EXCLUDE USING gist (
         project_id WITH =,
         resource_id WITH =,
         span WITH &&
       )`
  );

  await knex.raw(`CREATE UNLOGGED TABLE classification_jobs (
    job_id BIGSERIAL PRIMARY KEY,
    log_id UUID NOT NULL UNIQUE,
    prompt_content TEXT,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reserved_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0
  )`);

  await knex.schema.raw('CREATE INDEX classification_jobs_inserted_idx ON classification_jobs (inserted_at)');
  await knex.schema.raw('CREATE INDEX classification_jobs_reserved_idx ON classification_jobs (reserved_at)');
}

export async function down(knex) {
  await knex.schema.raw('DROP TABLE IF EXISTS classification_jobs');
  await knex.schema.dropTableIfExists('invoice');
  await knex.schema.dropTableIfExists('billing_record');
  await knex.schema.dropTableIfExists('ledger_events');
  await knex.schema.dropTableIfExists('billing_rate');
  await knex.schema.dropTableIfExists('payment_method');
  await knex.schema.dropTableIfExists('project');
  await knex.schema.dropTableIfExists('billing_info');
}

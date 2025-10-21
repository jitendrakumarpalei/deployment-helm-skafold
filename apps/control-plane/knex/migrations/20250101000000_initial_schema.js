/**
 * Initial schema setup for the control plane.
 *
 * This migration is safe to run as it only creates new tables and does not
 * modify existing data. All `notNullable` columns have default values.
 */
export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  await knex.schema.createTable('api_clients', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable();
    table.text('api_key').notNullable().unique();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('provider_credentials', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('api_client_id').notNullable().references('id').inTable('api_clients').onDelete('CASCADE');
    table.text('provider').notNullable();
    table.text('virtual_key').notNullable().unique();
    table.text('provider_api_key').notNullable();
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['api_client_id'], 'provider_credentials_api_client_id_idx');
    table.index(['provider'], 'provider_credentials_provider_idx');
  });

  await knex.schema.createTable('provider_models', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('provider').notNullable();
    table.text('model_name').notNullable();
    table.text('display_name');
    table.text('description');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['provider'], 'provider_models_provider_idx');
    table.unique(['provider', 'model_name'], { indexName: 'provider_models_provider_model_unique' });
  });

  await knex.schema.createTable('signed_url_replays', (table) => {
    table.uuid('session_id').notNullable();
    table.uuid('nonce').notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['session_id', 'nonce'], { constraintName: 'signed_url_replays_pkey' });
    table.index(['expires_at'], 'signed_url_replays_exp_idx');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('signed_url_replays');
  await knex.schema.dropTableIfExists('provider_models');
  await knex.schema.dropTableIfExists('provider_credentials');
  await knex.schema.dropTableIfExists('api_clients');
}

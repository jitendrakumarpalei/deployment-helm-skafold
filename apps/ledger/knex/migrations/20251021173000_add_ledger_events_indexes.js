/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const up = async (knex) => {
  await knex.schema.alterTable('ledger_events', (table) => {
    table.index(['user_id'], 'idx_ledger_events_user_id');
    table.index(['timestamp'], 'idx_ledger_events_timestamp');
    table.index(['user_id', 'timestamp'], 'idx_ledger_events_user_id_timestamp');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const down = async (knex) => {
  await knex.schema.alterTable('ledger_events', (table) => {
    table.dropIndex(['user_id'], 'idx_ledger_events_user_id');
    table.dropIndex(['timestamp'], 'idx_ledger_events_timestamp');
    table.dropIndex(['user_id', 'timestamp'], 'idx_ledger_events_user_id_timestamp');
  });
};

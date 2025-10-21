/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const up = async (knex) => {
  await knex.schema.createTable('classification_jobs_failed', (table) => {
    table.increments('failed_job_id').primary();
    table.integer('original_job_id').notNullable();
    table.string('log_id').notNullable();
    table.text('prompt_content');
    table.timestamp('failed_at').defaultTo(knex.fn.now());
    table.jsonb('error_details');
    table.integer('attempts').notNullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export const down = async (knex) => {
  await knex.schema.dropTable('classification_jobs_failed');
};

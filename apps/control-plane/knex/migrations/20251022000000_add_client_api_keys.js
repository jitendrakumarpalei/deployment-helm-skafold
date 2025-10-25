/**
 * Add client_api_keys table for temporary storage of client-provided API keys.
 *
 * This allows clients to pass their own provider API keys at presign time,
 * which are stored temporarily and auto-deleted after expiry using pg_cron.
 *
 * Security: Keys are encrypted at rest using pgcrypto.
 */
export async function up(knex) {
  // pgcrypto extension should already exist from initial_schema migration
  // Create table for temporary client API keys
  await knex.schema.createTable('client_api_keys', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('api_client_id').notNullable().references('id').inTable('api_clients').onDelete('CASCADE');
    table.text('provider').notNullable(); // e.g., 'gemini', 'openai', 'anthropic'
    table.text('encrypted_key').notNullable(); // pgcrypto encrypted API key
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['api_client_id', 'provider'], 'client_api_keys_client_provider_idx');
    table.index(['expires_at'], 'client_api_keys_expires_at_idx');
  });

  // Try to enable pg_cron extension for automatic cleanup (may require superuser)
  // If it fails, manual cleanup via cron job or application logic is needed
  // Note: We do this outside the migration transaction to avoid aborting on failure
  const hasExtension = await knex.raw(`
    SELECT EXISTS (
      SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) AS has_pg_cron
  `);

  if (hasExtension.rows[0].has_pg_cron) {
    // Schedule cleanup job to run every hour
    try {
      await knex.raw(`
        SELECT cron.schedule(
          'cleanup-expired-client-api-keys',
          '0 * * * *',
          $$DELETE FROM client_api_keys WHERE expires_at < NOW()$$
        ) WHERE NOT EXISTS (
          SELECT 1 FROM cron.job WHERE jobname = 'cleanup-expired-client-api-keys'
        )
      `);
    } catch (error) {
      console.warn('Could not schedule pg_cron job:', error);
    }
  } else {
    console.warn('pg_cron extension not available - client API keys will need manual cleanup');
    console.warn('To enable: CREATE EXTENSION pg_cron; (requires superuser privileges)');
  }
}

export async function down(knex) {
  // Try to unschedule the cron job
  try {
    await knex.raw(`
      SELECT cron.unschedule('cleanup-expired-client-api-keys')
    `);
  } catch (error) {
    // Ignore if pg_cron is not available
  }

  await knex.schema.dropTableIfExists('client_api_keys');
}

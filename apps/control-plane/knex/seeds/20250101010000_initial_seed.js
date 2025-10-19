export async function seed(knex) {
  await knex('signed_url_replays').del();
  await knex('provider_credentials').del();
  await knex('provider_models').del();
  await knex('api_clients').del();

  const [client] = await knex('api_clients')
    .insert({
      name: 'Demo Workspace',
      api_key: 'sk-stringcost-demo',
    })
    .returning(['id']);

  const clientId = client?.id;

  if (!clientId) {
    throw new Error('Failed to insert demo API client');
  }

  await knex('provider_credentials').insert([
    {
      api_client_id: clientId,
      provider: 'openai',
      virtual_key: 'vk-openai-demo',
      provider_api_key: 'sk-openai-demo',
      metadata: { tier: 'demo', environment: 'sandbox' },
    },
    {
      api_client_id: clientId,
      provider: 'anthropic',
      virtual_key: 'vk-anthropic-demo',
      provider_api_key: 'sk-anthropic-demo',
      metadata: { tier: 'demo', environment: 'sandbox' },
    },
  ]);

  await knex('provider_models').insert([
    {
      provider: 'openai',
      model_name: 'gpt-4o-mini',
      display_name: 'OpenAI GPT-4o Mini',
      description: 'Lightweight chat-optimised model suited for demos.',
    },
    {
      provider: 'anthropic',
      model_name: 'claude-3-haiku',
      display_name: 'Anthropic Claude 3 Haiku',
      description: 'Entry-tier Claude model for testing.',
    },
  ]);
}

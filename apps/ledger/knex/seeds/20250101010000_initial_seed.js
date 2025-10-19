export async function seed(knex) {
  await knex('classification_jobs').del();
  await knex('invoice').del();
  await knex('billing_record').del();
  await knex('ledger_events').del();
  await knex('payment_method').del();
  await knex('project').del();
  await knex('billing_rate').del();
  await knex('billing_info').del();

  const [billingInfo] = await knex('billing_info')
    .insert({
      stripe_customer_id: 'cus_demo_123',
      country_code: 'US',
      vat_registered: false,
    })
    .returning(['id']);

  const billingInfoId = billingInfo?.id;

  if (!billingInfoId) {
    throw new Error('Failed to insert demo billing_info');
  }

  const [project] = await knex('project')
    .insert({
      name: 'Demo Project',
      billing_info_id: billingInfoId,
      credit: 25,
      discount_pct: 10,
    })
    .returning(['id']);

  const projectId = project?.id;

  if (!projectId) {
    throw new Error('Failed to insert demo project');
  }

  const [rate] = await knex('billing_rate')
    .insert({
      resource_type: 'llm_tokens',
      resource_family: 'gpt-4o-mini',
      location: 'us',
      unit_price: 0.001,
      unit_name: 'token',
      effective_from: new Date(),
    })
    .returning(['id']);

  const rateId = rate?.id;

  if (!rateId) {
    throw new Error('Failed to insert demo billing_rate');
  }

  await knex('ledger_events').insert({
    run_id: '00000000-0000-0000-0000-000000000001',
    user_id: 'demo-user',
    step_name: 'demo-chat',
    action_type: 'chat_completion',
    outcome: 'success',
    duration_ms: 1420,
    cost_cogs_micros: 1200,
    revenue_billed_micros: 3200,
  });

  const start = new Date('2025-01-01T00:00:00Z');
  const end = new Date('2025-01-02T00:00:00Z');

  await knex('billing_record').insert({
    project_id: projectId,
    resource_id: '00000000-0000-0000-0000-0000000000aa',
    resource_name: 'demo-gateway-endpoint',
    span: knex.raw("tstzrange(?, ?, '[)')", [start, end]),
    billing_rate_id: rateId,
    amount: 123.456,
  });

  await knex('invoice').insert({
    project_id: projectId,
    begin_time: start,
    end_time: end,
    invoice_number: '2025-01-DEMO-0001',
    status: 'paid',
    content: {
      issuer: 'StringCost Demo',
      lines: [
        {
          description: 'LLM usage',
          amount: 123.456,
        },
      ],
    },
    subtotal: 123.456,
    tax: 0,
    total: 123.456,
  });
}

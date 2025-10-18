exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });
  pgm.createExtension('btree_gist', { ifNotExists: true });

  pgm.createTable('billing_info', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    stripe_customer_id: { type: 'text', notNull: true, unique: true },
    country_code: { type: 'text' },
    tax_id: { type: 'text' },
    vat_registered: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('project', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    billing_info_id: {
      type: 'uuid',
      references: 'billing_info',
      onDelete: 'set null'
    },
    credit: { type: 'numeric(12,6)', notNull: true, default: 0 },
    discount_pct: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('payment_method', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    billing_info_id: {
      type: 'uuid',
      references: 'billing_info',
      notNull: true,
      onDelete: 'cascade'
    },
    stripe_payment_method_id: { type: 'text', notNull: true, unique: true },
    brand: { type: 'text' },
    last4: { type: 'text' },
    exp_month: { type: 'integer' },
    exp_year: { type: 'integer' },
    preauth_amount: { type: 'numeric(12,6)' },
    preauth_intent_id: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('billing_rate', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    resource_type: { type: 'text', notNull: true },
    resource_family: { type: 'text' },
    location: { type: 'text' },
    unit_price: { type: 'numeric(12,6)', notNull: true },
    unit_name: { type: 'text', notNull: true },
    effective_from: { type: 'timestamptz', notNull: true },
    effective_to: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('ledger_events', {
    event_id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    run_id: { type: 'uuid', notNull: true },
    user_id: { type: 'text', notNull: true },
    timestamp: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    step_name: { type: 'text' },
    action_type: { type: 'text', notNull: true, default: 'unknown' },
    outcome: { type: 'text', notNull: true },
    duration_ms: { type: 'integer' },
    cost_cogs_micros: { type: 'bigint', notNull: true, default: 0 },
    revenue_billed_micros: { type: 'bigint', notNull: true, default: 0 },
    metadata: { type: 'jsonb' }
  });

  pgm.createIndex('ledger_events', ['run_id'], { name: 'idx_ledger_events_run_id' });

  pgm.createTable('billing_record', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'project',
      onDelete: 'cascade'
    },
    resource_id: { type: 'uuid', notNull: true },
    resource_name: { type: 'text' },
    span: { type: 'tstzrange', notNull: true },
    billing_rate_id: {
      type: 'uuid',
      references: 'billing_rate',
      onDelete: 'set null'
    },
    amount: { type: 'numeric(12,6)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('billing_record', ['project_id']);
  pgm.createIndex('billing_record', ['billing_rate_id']);

  pgm.addConstraint(
    'billing_record',
    'billing_record_no_overlap',
    {
      exclude: 'USING gist (project_id WITH =, resource_id WITH =, span WITH &&)'
    }
  );

  pgm.createTable('invoice', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'project',
      onDelete: 'cascade'
    },
    begin_time: { type: 'timestamptz', notNull: true },
    end_time: { type: 'timestamptz', notNull: true },
    invoice_number: { type: 'text', notNull: true, unique: true },
    status: { type: 'text', notNull: true },
    content: { type: 'jsonb' },
    subtotal: { type: 'numeric(12,6)', notNull: true, default: 0 },
    tax: { type: 'numeric(12,6)', notNull: true, default: 0 },
    total: { type: 'numeric(12,6)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
};

exports.down = async (pgm) => {
  pgm.dropTable('invoice');
  pgm.dropConstraint('billing_record', 'billing_record_no_overlap');
  pgm.dropTable('billing_record');
  pgm.dropTable('ledger_events');
  pgm.dropTable('billing_rate');
  pgm.dropTable('payment_method');
  pgm.dropTable('project');
  pgm.dropTable('billing_info');
};

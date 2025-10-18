exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createTable('api_clients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    api_key: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createTable('provider_credentials', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    api_client_id: {
      type: 'uuid',
      notNull: true,
      references: 'api_clients',
      onDelete: 'cascade'
    },
    provider: { type: 'text', notNull: true },
    virtual_key: { type: 'text', notNull: true, unique: true },
    provider_api_key: { type: 'text', notNull: true },
    metadata: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('provider_credentials', ['api_client_id']);
  pgm.createIndex('provider_credentials', ['provider']);

  pgm.createTable('provider_models', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    provider: { type: 'text', notNull: true },
    model_name: { type: 'text', notNull: true },
    display_name: { type: 'text' },
    description: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.createIndex('provider_models', ['provider']);
  pgm.createIndex('provider_models', ['provider', 'model_name'], { unique: true });
};

exports.down = async (pgm) => {
  pgm.dropTable('provider_models');
  pgm.dropTable('provider_credentials');
  pgm.dropTable('api_clients');
};

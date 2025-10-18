exports.up = async (pgm) => {
  pgm.createTable('signed_url_replays', {
    session_id: { type: 'uuid', notNull: true },
    nonce: { type: 'uuid', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });

  pgm.addConstraint('signed_url_replays', 'signed_url_replays_pkey', {
    primaryKey: ['session_id', 'nonce']
  });

  pgm.createIndex('signed_url_replays', ['expires_at'], { name: 'signed_url_replays_exp_idx' });
};

exports.down = async (pgm) => {
  pgm.dropTable('signed_url_replays');
};

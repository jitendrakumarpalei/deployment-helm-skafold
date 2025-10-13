exports.shorthands = undefined;

exports.up = async (pgm) => {
  pgm.sql(`
    CREATE UNLOGGED TABLE classification_jobs (
      job_id BIGSERIAL PRIMARY KEY,
      log_id UUID NOT NULL UNIQUE,
      prompt_content TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reserved_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);

  pgm.createIndex('classification_jobs', ['inserted_at']);
  pgm.createIndex('classification_jobs', ['reserved_at']);
};

exports.down = async (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS classification_jobs;');
};

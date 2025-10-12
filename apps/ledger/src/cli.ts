#!/usr/bin/env node
import { runMigrations } from './migrate.js';

const args = process.argv.slice(2);
let direction: 'up' | 'down' = 'up';
let count: number | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === 'down' || arg === 'up') {
    direction = arg;
  }
  if (arg === '--count' && args[i + 1]) {
    count = Number(args[i + 1]);
    i += 1;
  }
}

runMigrations({ direction, count })
  .then(() => {
    console.log(`Migrations ${direction === 'up' ? 'applied' : 'reverted'} successfully.`);
    process.exit(0);
  })
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });

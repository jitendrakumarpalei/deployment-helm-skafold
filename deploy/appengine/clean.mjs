#!/usr/bin/env node
import { rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

const targets = [
  'apps/control-plane/dist',
  'apps/event-collector/dist',
  'apps/gateway/dist',
  'apps/ledger/dist',
  'apps/worker/dist',
  'vendor/portkey-gateway/build',
  'app.yaml'
].map((p) => join(ROOT, p));

async function safeRemove(path) {
  try {
    await stat(path);
  } catch {
    return;
  }
  await rm(path, { recursive: true, force: true });
  console.log(`[clean] removed ${path}`);
}

(async () => {
  for (const target of targets) {
    await safeRemove(target);
  }
})();

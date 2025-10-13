#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const appengineDir = path.join(rootDir, 'deploy/appengine');
const servicesDir = path.join(appengineDir, 'services');
const envPath = process.env.APPENGINE_ENV_FILE ?? path.join(appengineDir, '.env');

function loadEnv(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Env file not found: ${filePath}`);
  }
  const env = {};
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

function renderTemplate(tplPath, env) {
  let raw = readFileSync(tplPath, 'utf8');

  // Remove VPC connector block if not supplied
  if (!env.VPC_CONNECTOR) {
    raw = raw.replace(/\n?vpc_access_connector:\n(?:[ \t]+.*\n)*/g, '\n');
  }

  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    if (key in env) {
      return env[key];
    }
    throw new Error(`Missing env var '${key}' required by ${path.basename(tplPath)}`);
  });
}

function main() {
  const env = loadEnv(envPath);
  const files = readdirSync(servicesDir);
  for (const file of files) {
    if (!file.endsWith('.yaml.tpl')) continue;
    const tplPath = path.join(servicesDir, file);
    const outPath = path.join(servicesDir, file.replace(/\.tpl$/, ''));
    const rendered = renderTemplate(tplPath, env);
    writeFileSync(outPath, rendered, 'utf8');
    console.log(`[render] wrote ${outPath}`);
  }
}

main();

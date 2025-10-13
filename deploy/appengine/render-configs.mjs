#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const APPENGINE_DIR = path.dirname(new URL(import.meta.url).pathname);
const SERVICES_DIR = path.join(APPENGINE_DIR, 'services');
const ENV_FILE = process.argv[2] ?? process.env.APPENGINE_ENV_FILE ?? path.join(APPENGINE_DIR, '.env');

function loadEnv(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`App Engine deploy env file not found: ${filePath}`);
  }
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    env[key] = value;
  }
  return env;
}

function renderTemplate(templatePath, env) {
  const raw = readFileSync(templatePath, 'utf8');
  return raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    if (key in env) {
      return env[key];
    }
    throw new Error(`Missing environment variable '${key}' for template ${path.basename(templatePath)}`);
  });
}

function main() {
  const env = loadEnv(ENV_FILE);
  const files = readdirSync(SERVICES_DIR);
  for (const file of files) {
    if (!file.endsWith('.yaml.tpl')) continue;
    const tplPath = path.join(SERVICES_DIR, file);
    const outputPath = path.join(SERVICES_DIR, file.replace(/\.tpl$/, ''));
    const rendered = renderTemplate(tplPath, env);
    writeFileSync(outputPath, rendered, 'utf8');
    console.log(`[render] wrote ${outputPath}`);
  }
}

main();

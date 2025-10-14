#!/usr/bin/env node
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const servicesDir = path.join(rootDir, 'deploy/appengine/services');
const stagingDir = path.join(rootDir, 'deploy/appengine/staging');

const services = [
  {
    name: 'gateway',
    workspace: 'gateway',
    entry: 'dist/server.js',
    distSource: path.join(rootDir, 'apps/gateway/dist'),
    appYaml: path.join(servicesDir, 'gateway.yaml')
  },
  {
    name: 'control-plane',
    workspace: 'control-plane',
    entry: 'dist/index.js',
    distSource: path.join(rootDir, 'apps/control-plane/dist'),
    appYaml: path.join(servicesDir, 'control-plane.yaml')
  },
  {
    name: 'event-collector',
    workspace: 'event-collector',
    entry: 'dist/index.js',
    distSource: path.join(rootDir, 'apps/event-collector/dist'),
    appYaml: path.join(servicesDir, 'event-collector.yaml')
  },
  {
    name: 'worker',
    workspace: 'worker',
    entry: 'dist/server.js',
    distSource: path.join(rootDir, 'apps/worker/dist'),
    appYaml: path.join(servicesDir, 'worker.yaml')
  },
];

function ensureClean(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function stageService(service) {
  const stagePath = path.join(stagingDir, service.name);
  ensureClean(stagePath);

  // copy dist output
  cpSync(service.distSource, path.join(stagePath, 'dist'), { recursive: true });

  // copy app.yaml
  cpSync(service.appYaml, path.join(stagePath, 'app.yaml'));

  // produce package.json from workspace package
  const sourcePkgPath = path.join(rootDir, `apps/${service.workspace}/package.json`);
  const pkg = JSON.parse(readFileSync(sourcePkgPath, 'utf8'));
  const stagedPkg = {
    name: `stringcost-${service.name}`,
    version: pkg.version ?? '0.0.1',
    private: true,
    type: 'module',
    scripts: {
      start: `node ${service.entry}`
    },
    dependencies: pkg.dependencies ?? {}
  };

  writeFileSync(path.join(stagePath, 'package.json'), JSON.stringify(stagedPkg, null, 2));
}

ensureClean(stagingDir);
mkdirSync(stagingDir, { recursive: true });
services.forEach(stageService);
console.log(`[stage] staged services in ${stagingDir}`);

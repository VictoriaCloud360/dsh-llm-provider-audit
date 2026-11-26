#!/usr/bin/env node
/*
 * llm-provider-audit :: apply.mjs
 * Applies removals produced by audit.mjs to a profile's cordis.patch.yml.
 * Always writes a timestamped backup next to the file and re-validates afterwards.
 *
 * Usage:
 *   node apply.mjs --profile <dir> --remove-models "token:z-ai/glm-5.3-free,google:gemini-3.5-flash"
 *   node apply.mjs --profile <dir> --remove-providers "token,cliproxy"
 *   node apply.mjs --profile <dir> --plan plan.json      # uses plan.removeModels + approved providers
 *   add --dry-run to print the change without writing
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  args[key] = next && !next.startsWith('--') ? argv[++i] : true;
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profileDir = args.profile
  ? path.resolve(args.profile)
  : process.env.DSH_PROFILE_DIR
    ? path.resolve(process.env.DSH_PROFILE_DIR)
    : path.join(dshHome, 'profiles', process.env.DSH_PROFILE || 'desktop');
const patchPath = path.join(profileDir, 'cordis.patch.yml');

if (!fs.existsSync(patchPath)) {
  console.error(`No patch layer at ${patchPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------- what to remove
const removeModels = new Map(); // provider -> Set(modelId)
const removeProviders = new Set();

function addModel(spec, explicitProvider) {
  const [a, ...rest] = spec.split(':');
  let prov = explicitProvider, model = spec;
  if (rest.length) { prov = a; model = rest.join(':'); }
  if (!prov || !model) return;
  if (!removeModels.has(prov)) removeModels.set(prov, new Set());
  removeModels.get(prov).add(model.trim());
}

if (args['remove-models']) {
  for (const spec of String(args['remove-models']).split(',')) if (spec.trim()) addModel(spec.trim());
}
if (args['remove-providers']) {
  for (const p of String(args['remove-providers']).split(',')) if (p.trim()) removeProviders.add(p.trim());
}
if (args.plan) {
  const plan = JSON.parse(fs.readFileSync(path.resolve(args.plan), 'utf8'));
  for (const r of plan.plan?.removeModels || plan.removeModels || []) {
    if (!removeModels.has(r.provider)) removeModels.set(r.provider, new Set());
    removeModels.get(r.provider).add(r.model);
  }
  for (const p of args['approved-providers'] ? String(args['approved-providers']).split(',') : []) {
    if (p.trim()) removeProviders.add(p.trim());
  }
}

if (!removeModels.size && !removeProviders.size) {
  console.error('Nothing to do: pass --remove-models, --remove-providers, or --plan.');
  process.exit(1);
}

// ---------------------------------------------------------------- rewrite
const lines = fs.readFileSync(patchPath, 'utf8').split(/\r?\n/);
const indentOf = (l) => l.match(/^ */)[0].length;
const out = [];
const removed = [];
const skipped = [];

let inLlm = false, provider = null, skip = false;
const providerNames = new Set();

// which providers are referenced elsewhere in the patch layer (default model, titles, ...)
for (const l of lines) {
  const m = l.trim().match(/^(?:provider|defaultProvider):\s*([A-Za-z0-9_.\-]+)\s*$/);
  if (m) providerNames.add(m[1]);
}

for (const raw of lines) {
  const t = raw.trim();
  const ind = t ? indentOf(raw) : -1;

  if (ind === 0 && t.startsWith('- id:')) {
    inLlm = t === '- id: llm-pi-ai';
    provider = null; skip = false;
    out.push(raw);
    continue;
  }
  if (!inLlm) { out.push(raw); continue; }

  if (ind === 6 && /^[A-Za-z0-9_.\-]+:$/.test(t)) {
    const key = t.slice(0, -1);
    provider = key;
    skip = false;
    if (removeProviders.has(key)) {
      if (providerNames.has(key)) {
        skipped.push(`provider ${key} is referenced by a provider:/defaultProvider: entry — fix that reference first`);
        out.push(raw);
        continue;
      }
      removed.push('provider ' + key);
      skip = true;
      continue;
    }
    out.push(raw);
    continue;
  }
  if (!provider) { out.push(raw); continue; }

  if (skip) {
    if (ind === 10 && t.startsWith('- id:')) skip = false;
    else if (ind === 8 && !t.startsWith('- ')) skip = false;
    else continue;
  }

  if (ind === 10 && t.startsWith('- id:') && removeModels.has(provider)) {
    const id = t.slice(5).trim();
    if (removeModels.get(provider).has(id)) {
      removed.push(`model ${provider} :: ${id}`);
      skip = true;
      continue;
    }
  }
  out.push(raw);
}

if (!removed.length) {
  if (skipped.length) {
    console.log('nothing removable:');
    for (const s of skipped) console.log('  SKIPPED: ' + s);
    process.exit(1);
  }
  console.log('Nothing matched. No file written.');
  process.exit(0);
}

console.log('would remove:');
for (const r of removed) console.log('  ' + r);
for (const s of skipped) console.log('  SKIPPED: ' + s);

if (args['dry-run']) {
  console.log('\ndry run — file untouched');
  process.exit(0);
}

const backup = `${patchPath}.bak-${Date.now()}`;
fs.writeFileSync(backup, lines.join('\n'), 'utf8');
fs.writeFileSync(patchPath, out.join('\n'), 'utf8');

// ---------------------------------------------------------------- re-validate
const check = fs.readFileSync(patchPath, 'utf8').split(/\r?\n/);
const broken = [];
let cur = null, inLlm2 = false, prov = {};
for (let i = 0; i < check.length; i++) {
  const l = check[i], t = l.trim();
  if (!t || t.startsWith('#')) continue;
  const ind = indentOf(l);
  if (l.includes('\t')) broken.push(`tab indentation at line ${i + 1}`);
  if (ind === 0 && t.startsWith('- id:')) { inLlm2 = t === '- id: llm-pi-ai'; cur = null; continue; }
  if (!inLlm2) continue;
  if (ind === 6 && /^[A-Za-z0-9_.\-]+:$/.test(t)) { cur = t.slice(0, -1); prov[cur] = { models: 0, display: false, env: false }; continue; }
  if (!cur) { broken.push(`content at line ${i + 1} before any provider`); continue; }
  if (ind === 8 && t.startsWith('displayName:')) prov[cur].display = true;
  if (ind === 8 && t.startsWith('apiKeyEnv:')) prov[cur].env = true;
  if (ind === 10 && t.startsWith('- id:')) prov[cur].models++;
}
for (const [k, v] of Object.entries(prov)) {
  if (!v.display) broken.push(`${k}: displayName missing`);
  if (!v.env) broken.push(`${k}: apiKeyEnv missing`);
  if (!v.models) broken.push(`${k}: no models left`);
}

console.log(`\nbackup : ${backup}`);
console.log(`lines  : ${lines.length} -> ${out.length}`);
console.log('providers left:');
for (const [k, v] of Object.entries(prov)) console.log(`  ${k} (${v.models} models)`);
if (broken.length) {
  console.log('\nVALIDATION PROBLEMS — restore the backup:');
  for (const b of broken) console.log('  ' + b);
  process.exit(2);
}
console.log('\nvalidation: OK — restart DeepSeek Harness so the patch layer is re-read.');

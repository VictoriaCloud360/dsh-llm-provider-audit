#!/usr/bin/env node
/*
 * llm-provider-audit :: audit.mjs
 * Audits every LLM provider configured in a DSH profile against its real API.
 * Read-only: never edits config, never prints secrets.
 *
 * Usage:
 *   node audit.mjs [--profile <dir>] [--json <out.json>] [--no-chat]
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

function resolveProfile() {
  if (args.profile) return path.resolve(args.profile);
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR);
  return path.join(dshHome, 'profiles', process.env.DSH_PROFILE || 'desktop');
}

const profileDir = resolveProfile();
const patchPath = path.join(profileDir, 'cordis.patch.yml');
const problems = [];
if (!fs.existsSync(patchPath)) {
  console.error(`No patch layer found at ${patchPath}`);
  const alt = ['cordis.patch.yml', 'config.patch.yml'];
  for (const f of alt) console.error('  tried: ' + path.join(profileDir, f));
  process.exit(1);
}

// ---------------------------------------------------------------- YAML shapes
// The patch layer is a regular 2-space indented YAML array of loader entries.
// A structural parse is enough here and avoids any dependency.
const lines = fs.readFileSync(patchPath, 'utf8').split(/\r?\n/);
const indentOf = (l) => l.match(/^ */)[0].length;

const entries = [];        // [{ id, name, configStart }]
const providers = {};      // key -> { key, displayName, api, baseURL, apiKeyEnv, models: [{id,name}] }
const modelRefs = [];      // every `provider:` + `model:` pair found anywhere

let entry = null, provider = null, inModels = false, lastModel = null, lastProvider = null;
let pendingProviderRef = null;

for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const t = raw.trim();
  if (!t || t.startsWith('#')) continue;
  const ind = indentOf(raw);

  if (ind === 0 && t.startsWith('- id:')) {
    entry = { id: t.slice(5).trim(), name: null, line: i + 1 };
    entries.push(entry);
    provider = null; inModels = false; lastModel = null; lastProvider = null; pendingProviderRef = null;
    continue;
  }
  if (ind === 2 && entry && t.startsWith('name:')) { entry.name = t.slice(5).trim().replace(/^"|"$/g, ''); continue; }

  // generic provider/model references anywhere in any entry
  const provRef = t.match(/^(?:defaultProvider|provider):\s*([A-Za-z0-9_.\-]+)\s*$/);
  if (provRef) pendingProviderRef = { provider: provRef[1], line: i + 1 };
  const modelRef = t.match(/^(?:defaultModel|model):\s*(\S+)\s*$/);
  if (modelRef && pendingProviderRef) {
    modelRefs.push({ provider: pendingProviderRef.provider, model: modelRef[1], line: pendingProviderRef.line });
    pendingProviderRef = null;
  }

  if (!entry || entry.id !== 'llm-pi-ai') continue;

  if (ind === 6 && /^[A-Za-z0-9_.\-]+:$/.test(t)) {
    provider = { key: t.slice(0, -1), displayName: null, api: null, apiKeyEnv: null, baseURL: null, models: [] };
    providers[provider.key] = provider;
    inModels = false; lastModel = null;
    continue;
  }
  if (!provider) continue;

  if (ind === 8) {
    inModels = t === 'models:';
    const kv = t.match(/^(displayName|apiKeyEnv|api|baseURL):\s*(.*)$/);
    if (kv) { provider[kv[1]] = kv[2].trim().replace(/^"|"$/g, ''); continue; }
  }
  if (ind === 10 && inModels) {
    const mi = t.match(/^- id:\s*(.+)$/);
    if (mi) { lastModel = { id: mi[1].trim(), name: null }; provider.models.push(lastModel); continue; }
  }
  if (ind === 12 && inModels && lastModel && t.startsWith('name:')) lastModel.name = t.slice(5).trim();
}

// ---------------------------------------------------------------- credentials
function readCredentials() {
  const out = {};
  for (const candidate of [path.join(dshHome, '.credentials.yaml'), path.join(profileDir, '.credentials.yaml')]) {
    if (!fs.existsSync(candidate)) continue;
    for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/);
      if (m && !out[m[1]]) out[m[1]] = m[2];
    }
  }
  return out;
}
const credentials = readCredentials();
const keyFor = (env) => (env && (credentials[env] || process.env[env])) || null;
const fingerprint = (k) => (k ? k.slice(0, 4) + '…' + k.slice(-4) : null);

// ---------------------------------------------------------------- endpoints
const NATIVE = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
};

async function http(url, init = {}, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, text, json };
  } catch (e) {
    return { status: 'UNREACHABLE', ok: false, text: String(e.message || e), json: null };
  } finally { clearTimeout(timer); }
}

function jsonModelIds(json) {
  if (!json) return [];
  const arr = json.data || json.models || [];
  return arr.map((m) => m.id || (m.name || '').replace(/^models\//, '')).filter(Boolean);
}

async function listModels(p) {
  const key = keyFor(p.apiKeyEnv);
  if (!key) return { status: 'NO_KEY', ids: [], note: `missing ${p.apiKeyEnv}` };

  if (p.key === 'google' && !p.baseURL) {
    const r = await http(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    return { status: r.status, ids: jsonModelIds(r.json), body: r.ok ? null : r.text.slice(0, 200) };
  }
  const base = p.baseURL || NATIVE[p.key];
  if (!base) return { status: 'UNKNOWN', ids: [], note: 'no baseURL and no known native endpoint' };
  if (/anthropic/i.test(p.key) || /api\.anthropic\.com/.test(base)) {
    const r = await http(base.replace(/\/$/, '') + '/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    return { status: r.status, ids: jsonModelIds(r.json), body: r.ok ? null : r.text.slice(0, 200) };
  }
  const r = await http(base.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, ids: jsonModelIds(r.json), body: r.ok ? null : r.text.slice(0, 200) };
}

async function chatTest(p, model) {
  const key = keyFor(p.apiKeyEnv);
  if (!key || !model) return { status: 'SKIP' };
  if (p.key === 'google' && !p.baseURL) {
    const r = await http(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 4 } }),
      },
      60000,
    );
    return { status: r.status, model };
  }
  const base = p.baseURL || NATIVE[p.key];
  if (!base) return { status: 'SKIP', model };
  const extra = /openrouter/.test(base) ? { 'HTTP-Referer': 'https://localhost', 'X-Title': 'dsh-audit' } : {};
  const r = await http(
    base.replace(/\/$/, '') + '/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 }),
    },
    60000,
  );
  return { status: r.status, model, body: r.ok ? null : r.text.slice(0, 200) };
}

const isFree = (id) => /:free$|-free$|\/free$/.test(id);

// ---------------------------------------------------------------- run
const report = { profileDir, patchPath, providers: [], modelRefs, plan: { removeModels: [], askProviders: [], fixRefs: [] } };

for (const p of Object.values(providers)) {
  const listing = await listModels(p);
  const available = new Set(listing.ids);
  const configured = p.models.map((m) => m.id);
  const missing = listing.ids.length ? configured.filter((id) => !available.has(id)) : [];

  let chat = { status: 'SKIP' };
  if (!args['no-chat'] && listing.status === 200) {
    const candidates = configured.filter((id) => available.has(id));
    const preferred = candidates.find(isFree) || candidates[0];
    chat = await chatTest(p, preferred);
  }

  const providerBroken = ['NO_KEY', 'UNREACHABLE', 401, 402, 403].includes(listing.status) ||
    (!args['no-chat'] && [401, 402, 403].includes(chat.status));

  const entryOut = {
    key: p.key,
    displayName: p.displayName,
    api: p.api || '(default)',
    baseURL: p.baseURL || '(default)',
    apiKeyEnv: p.apiKeyEnv,
    keyPresent: Boolean(keyFor(p.apiKeyEnv)),
    keyFingerprint: fingerprint(keyFor(p.apiKeyEnv)),
    listingStatus: listing.status,
    listingNote: listing.note || null,
    availableCount: listing.ids.length,
    configuredCount: configured.length,
    deadIds: missing,
    chatStatus: chat.status,
    chatModel: chat.model || null,
    chatBody: chat.body || null,
    listingBody: listing.body || null,
    verdict: providerBroken ? 'BROKEN' : missing.length ? 'PARTIAL' : 'OK',
  };
  report.providers.push(entryOut);

  for (const id of missing) report.plan.removeModels.push({ provider: p.key, model: id });
  if (providerBroken) report.plan.askProviders.push({ provider: p.key, reason: `listing=${listing.status} chat=${chat.status}` });
}

// references (default model, title model, etc.) must point at surviving providers/models
for (const ref of modelRefs) {
  const p = providers[ref.provider];
  if (!p) { report.plan.fixRefs.push({ ...ref, problem: 'provider not defined' }); continue; }
  if (p.models.length && !p.models.some((m) => m.id === ref.model)) {
    report.plan.fixRefs.push({ ...ref, problem: 'model not listed under this provider' });
  }
}

// ---------------------------------------------------------------- print
const pad = (s, n) => String(s).padEnd(n);
console.log(`profile : ${profileDir}`);
console.log(`patch   : ${patchPath}`);
console.log('');
console.log(pad('provider', 14) + pad('listing', 10) + pad('configured', 11) + pad('available', 10) + pad('chat', 8) + 'verdict');
console.log('-'.repeat(70));
for (const p of report.providers) {
  console.log(
    pad(p.key, 14) + pad(p.listingStatus, 10) + pad(p.configuredCount, 11) + pad(p.availableCount, 10) +
    pad(p.chatStatus, 8) + p.verdict,
  );
}

if (report.plan.removeModels.length) {
  console.log('\n>>> invalid model ids (not offered by the API — safe to delete):');
  for (const r of report.plan.removeModels) console.log(`    ${r.provider} :: ${r.model}`);
}
if (report.plan.askProviders.length) {
  console.log('\n>>> providers that cannot work — ASK the user before deleting:');
  for (const r of report.plan.askProviders) console.log(`    ${r.provider}  (${r.reason})`);
}
if (report.plan.fixRefs.length) {
  console.log('\n>>> broken references:');
  for (const r of report.plan.fixRefs) console.log(`    line ${r.line}: ${r.provider}/${r.model} — ${r.problem}`);
}
if (!report.plan.removeModels.length && !report.plan.askProviders.length && !report.plan.fixRefs.length) {
  console.log('\nNo problems found.');
}

if (args.json) {
  fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nplan written to ${path.resolve(args.json)}`);
}

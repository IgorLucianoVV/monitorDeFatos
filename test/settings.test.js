import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-settings-'));
process.env.SETTINGS_FILE = path.join(dir, 'settings.json');
process.env.ANTHROPIC_API_KEY = 'env-anthropic-0000';
process.env.OPENAI_API_KEY = '';
process.env.TAVILY_API_KEY = '';
process.env.DEEPGRAM_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.ACCESS_TOKEN = '';

const { config } = await import('../src/config.js');
const { loadSettings, updateKeys, keyStatus, onKeysChange } = await import('../src/settings.js');
const { createApp } = await import('../src/server.js');

test('chave da tela tem prioridade sobre .env e remover volta ao .env', () => {
  loadSettings();
  let notified = [];
  const off = onKeysChange((c) => { notified = c; });
  updateKeys({ anthropic: 'sk-ant-tela-1234', openai: 'sk-openai-abcd' });
  assert.equal(config.keys.anthropic, 'sk-ant-tela-1234');
  assert.deepEqual(notified.sort(), ['anthropic', 'openai']);
  assert.deepEqual(keyStatus().anthropic, { configurada: true, final: '1234', origem: 'tela' });

  const disk = JSON.parse(fs.readFileSync(process.env.SETTINGS_FILE, 'utf8'));
  assert.equal(disk.keys.openai, 'sk-openai-abcd');
  if (process.platform !== 'win32') assert.equal(fs.statSync(process.env.SETTINGS_FILE).mode & 0o777, 0o600);

  updateKeys({ anthropic: null });
  assert.equal(config.keys.anthropic, 'env-anthropic-0000');
  assert.equal(keyStatus().anthropic.origem, 'env');
  off();
});

test('persistência: recarrega do arquivo', () => {
  config.keys.openai = '';
  loadSettings();
  assert.equal(config.keys.openai, 'sk-openai-abcd');
});

test('rejeita chave com espaço ou curta', () => {
  assert.throws(() => updateKeys({ tavily: 'abc' }), /inválida/);
  assert.throws(() => updateKeys({ tavily: 'tvly abc defgh' }), /inválida/);
});

test('HTTP: GET nunca devolve a chave inteira; PUT de localhost salva e libera provedor', async () => {
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const g = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(g.editavel, true);
  assert.ok(!JSON.stringify(g).includes('sk-openai-abcd'));
  assert.equal(g.keys.openai.final, 'abcd');

  const before = await (await fetch(`${base}/api/health`)).json();
  assert.ok(!before.search.providers.includes('tavily'));

  const p = await fetch(`${base}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keys: { tavily: 'tvly-novachave-9999', invalido: 'x' } }),
  });
  const pj = await p.json();
  assert.equal(p.status, 200);
  assert.deepEqual(pj.alteradas, ['tavily']);

  const after = await (await fetch(`${base}/api/health`)).json();
  assert.ok(after.search.providers.includes('tavily'));

  const bad = await fetch(`${base}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: { tavily: 'x y' } }),
  });
  assert.equal(bad.status, 400);
  server.close();
});

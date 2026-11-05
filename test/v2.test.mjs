import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { initializeFiles, ConfigStore } from '../lib/store.mjs';
import { createBridgeServer } from '../server.mjs';
import { Solver } from '../lib/solver.mjs';
import { usageOf } from '../lib/lite.mjs';
import { bridgeConfig } from '../lib/ocs.mjs';
import { projectRoot } from '../lib/config.mjs';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ocs-v2-'));
  copyFileSync(resolve(projectRoot, 'config.example.json'), resolve(root, 'config.example.json'));
  return initializeFiles(root, {});
}
function configuredStore() {
  const store = storeFixture();
  const payload = store.publicConfig();
  payload.config.profiles.deepseek.model = 'test-model';
  store.save({ ...payload, secrets: { deepseek: 'sk-test-not-a-real-api-key' } });
  return store;
}
function modelResponse(content, protocol = 'openai') {
  return new Response(JSON.stringify(protocol === 'anthropic'
    ? { content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 15, output_tokens: 2 } }
    : { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 15, completion_tokens: 2 } }), { headers: { 'Content-Type': 'application/json' } });
}
async function withServer(run, fetchImpl = async () => modelResponse('["2"]')) {
  const store = configuredStore();
  const bridge = createBridgeServer(store.config, { store, fetchImpl });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening');
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(base + path, { ...options, headers: { Authorization: `Bearer ${store.config.token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
    return { response, value: await response.json() };
  };
  try { await run({ base, request, store }); }
  finally { bridge.server.closeAllConnections(); await new Promise(resolve => bridge.server.close(resolve)); }
}

test('V2 first launch initializes an empty workspace; public configuration never contains provider keys', () => {
  const store = storeFixture();
  assert.ok(existsSync(resolve(store.root, '.env')));
  assert.ok(store.config.token.length >= 24);
  const before = store.publicConfig();
  before.config.server.port = 9876;
  assert.notEqual(store.config.server.port, 9876, 'public snapshot is not mutable internal state');
  store.save({ config: before.config, expected_revision: before.revision, secrets: { deepseek: 'sk-test-private-key-123456' } });
  assert.equal(store.config.profiles.deepseek.apiKey, 'sk-test-private-key-123456');
  assert.equal(JSON.stringify(store.publicConfig()).includes('sk-test-private-key'), false);
  assert.equal(readFileSync(resolve(store.root, 'config.json'), 'utf8').includes('sk-test-private-key'), false);
  assert.equal(new ConfigStore(store.root, {}).config.profiles.deepseek.apiKey, 'sk-test-private-key-123456');
  assert.throws(() => store.save({ config: before.config, expected_revision: 'stale' }), { code: 'config_conflict' });
});

test('Lite/auto/full select correct prompt, output cap and image handling', async () => {
  const store = configuredStore();
  const calls = [];
  const solver = new Solver(store.config, { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return modelResponse(body.max_tokens === 32 ? 'B' : body.messages[1].content instanceof Array ? '{"kind":"completion","answer":["2"]}' : '["2"]');
  } });
  const lite = await solver.solve({ title: '1+1', type: 'single', options: ['1', '2'], mode: 'auto' });
  assert.equal(lite.mode, 'lite'); assert.equal(lite.answer, 'B');
  assert.equal(calls[0].max_tokens, 32); assert.equal(calls[0].response_format, undefined);
  assert.ok(calls[0].messages[0].content.length < 60);
  const image = await solver.solve({ title: '看 [图片1]', type: 'completion', images: [PNG], mode: 'auto' });
  assert.equal(image.mode, 'full'); assert.equal(calls[1].max_tokens, 4096);
  await assert.rejects(solver.solve({ title: '看 [图片1]', images: [PNG], mode: 'lite' }), { code: 'lite_text_only' });
  assert.equal(calls.length, 2);
});

test('Lite keeps arrays/code, maps Claude format, reports actual usage, and cache costs no extra call', async () => {
  const store = configuredStore();
  const profile = store.config.profiles.deepseek;
  profile.protocol = 'anthropic';
  let calls = 0;
  const solver = new Solver(store.config, { fetchImpl: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(typeof body.system, 'string'); assert.equal(body.messages.length, 1);
    return modelResponse('["C#","a|b;c"]', 'anthropic');
  } });
  const input = { title: '填空', type: 'completion', mode: 'lite', blank_count: 2 };
  const first = await solver.solve(input);
  assert.deepEqual(JSON.parse(first.answer), ['C#', 'a|b;c']);
  assert.equal(first.usage.total_tokens, 17);
  const second = await solver.solve(input);
  assert.equal(second.usage.total_tokens, 0); assert.equal(second.model_calls, 0); assert.equal(calls, 1);
  assert.equal(usageOf('openai', {}).reported, false);
  assert.equal(usageOf('anthropic', { usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 5 } }).total_tokens, 25);
});

test('V2 authenticated dashboard can save a new provider, hot reload, test and export each OCS mode', async () => {
  const sent = [];
  await withServer(async ({ base, request }) => {
    const index = await fetch(base + '/');
    assert.match(await index.text(), /OCS AI/);
    assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(base + '/admin/config')).status, 401);
    const { value: current } = await request('/admin/config');
    assert.equal(JSON.stringify(current).includes('sk-test-not'), false);
    current.config.profiles.second = { ...current.config.profiles.deepseek, name: 'Second', apiKeyEnv: 'SECOND_KEY', model: 'second-model' };
    current.config.routing.text = ['second'];
    const { value: saved } = await request('/admin/config', { method: 'PUT', body: JSON.stringify({ config: current.config, expected_revision: current.revision, secrets: { second: 'sk-test-second-provider' } }) });
    assert.ok(saved.revision !== current.revision);
    const { value: answer } = await request('/admin/test', { method: 'POST', body: JSON.stringify({ title: '1+1', type: 'completion', mode: 'lite' }) });
    assert.equal(answer.code, 1); assert.equal(answer.profile, 'second'); assert.equal(sent[0].model, 'second-model');
    const { value: metrics } = await request('/admin/state');
    assert.equal(metrics.stats.success, 1); assert.equal(metrics.stats.total_tokens, 17); assert.equal(metrics.history.length, 1);
    for (const mode of ['auto', 'lite', 'full']) {
      const { value: exported } = await request('/admin/ocs-config?mode=' + mode);
      assert.equal(exported[0].url.endsWith(mode === 'auto' ? '/api/answer' : '/api/answer/' + mode), true);
      assert.equal('images' in exported[0].data, mode !== 'lite');
      assert.equal(JSON.stringify(exported).includes('sk-test-'), false);
      for (const value of Object.values(exported[0].data)) if (value.handler) assert.equal(typeof Function(value.handler)(), 'function');
    }
    const blocked = await request('/admin/config', { method: 'PUT', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ config: current.config }) });
    assert.equal(blocked.response.status, 403);
  }, async (url, options) => { sent.push(JSON.parse(options.body)); return modelResponse('["2"]'); });
});

test('OCS explicit lite endpoint overrides full input, preserves diagnostics and refuses images before a model call', async () => {
  let calls = 0;
  await withServer(async ({ request }) => {
    const { value: result } = await request('/api/answer/lite', { method: 'POST', body: JSON.stringify({ title: '1+1', mode: 'full', type: 'completion' }) });
    assert.equal(result.mode, 'lite');
    const { value: image } = await request('/api/answer/lite', { method: 'POST', body: JSON.stringify({ title: '[图片1]', images: [PNG] }) });
    assert.equal(image.error.code, 'lite_text_only'); assert.equal(calls, 1);
    const basic = bridgeConfig('token', 'http://127.0.0.1:8765', '', 'lite')[0];
    assert.equal('images' in basic.data, false);
  }, async () => { calls++; return modelResponse('["2"]'); });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRuntime } from '../lib/portable.mjs';
import { validateConfig, projectRoot } from '../lib/config.mjs';
import { bridgeConfig, directConfig } from '../lib/ocs.mjs';
import { createBridgeServer } from '../server.mjs';
import { Solver } from '../lib/solver.mjs';

const runtime = createRuntime();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const TOKEN = 'test-local-bridge-token-1234567890123456';
const example = JSON.parse(readFileSync(resolve(projectRoot, 'config.example.json'), 'utf8'));
function config(mutate = () => {}) {
  const raw = structuredClone(example);
  raw.answering = { ...raw.answering, mode: 'full' };
  mutate(raw);
  return validateConfig(raw, { OCS_BRIDGE_TOKEN: TOKEN, DEEPSEEK_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'claude-test-key' });
}
function openai(answer, finish = 'stop') { return { choices: [{ finish_reason: finish, message: { content: JSON.stringify(answer) } }] }; }
function response(value, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } }); }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function withMock(handler, run, mutate = () => {}) {
  const upstream = http.createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    await handler(req, res, input ? JSON.parse(input) : null);
  });
  const endpoint = await listen(upstream);
  const c = config(raw => {
    raw.profiles.deepseek.endpoint = `${endpoint}/chat/completions`;
    raw.profiles.claude.endpoint = `${endpoint}/v1/messages`;
    mutate(raw);
  });
  const bridge = createBridgeServer(c);
  const base = await listen(bridge.server);
  try { await run({ base, solver: bridge.solver, config: c }); }
  finally { await close(bridge.server); await close(upstream); }
}
async function post(base, value, token = TOKEN) {
  const res = await fetch(`${base}/api/answer`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  return { status: res.status, data: await res.json() };
}

test('OCS question/option image numbering survives conversion and uses actual MIME', () => {
  const q = runtime.normalize({ title: '见 https://example.com/q.png', options: 'A. https://example.com/a.png\nB. 乙',
    suggestion_title: '见 [图片1]', suggestion_options: 'A. [图片2]\nB. 乙', images: [PNG, PNG], type: 'single' });
  assert.equal(q.images.length, 2);
  assert.equal(q.title, '见 [图片1]');
  assert.equal(q.promptOptions[0], 'A. [图片2]');
  assert.equal(q.images[1].mime, 'image/png');
  const jpeg = runtime.normalize({ title: '图片', images: ['data:image/png;base64,/9j/AA=='] });
  assert.equal(jpeg.images[0].mime, 'image/jpeg');
});

test('HTML/math/images retain formulas and C/C++ source', () => {
  const q = runtime.normalize({ title: `<p>x<sup>2</sup>&nbsp;+1 <img src="https://example.com/a.png"></p>\n#include <stdio.h>`, type: 'coding' });
  assert.match(q.title, /x\^\(2\)/);
  assert.match(q.title, /\[图片1\]/);
  assert.match(q.title, /#include <stdio.h>/);
  assert.equal(q.kind, 'subjective');
});

test('inline public images are attached; missing/private/blob/oversized images fail explicitly', () => {
  const q = runtime.normalize({ title: '看 ![图](https://example.com/a.png)' });
  assert.equal(q.images.length, 1);
  assert.throws(() => runtime.normalize({ title: '[图片2]', images: [PNG] }), { code: 'missing_image' });
  assert.throws(() => runtime.normalize({ title: '图', images: ['http://127.0.0.1/img.png'] }), { code: 'private_image_url' });
  assert.throws(() => runtime.normalize({ title: '图', images: ['blob:https://example.com/x'] }), { code: 'invalid_image' });
  assert.throws(() => runtime.normalize({ title: '图', images: [PNG] }, { maxImageBytes: 1 }), { code: 'image_too_large' });
  assert.throws(() => runtime.normalize({ title: '图', images: ['data:image/png;base64,broken'] }), { code: 'invalid_image' });
  assert.throws(() => runtime.normalize({ title: '图', images: [PNG, PNG] }, { maxImages: 1 }), { code: 'too_many_images' });
});

test('single/multiple labels are normalized and range checked', () => {
  const q = runtime.normalize({ title: '选正确项', type: 'multiple', options: ['甲', '乙', '丙'] });
  assert.equal(runtime.answer('{"kind":"multiple","choices":["C","A","A"],"answer":""}', q).answer, 'AC');
  assert.throws(() => runtime.answer('{"kind":"multiple","choices":["D"]}', q), { code: 'invalid_answer' });
  assert.throws(() => runtime.answer('{"choices":["A","B"]}', { ...q, kind: 'single' }), { code: 'invalid_answer' });
});

test('judgement accepts canonical synonyms but never guesses A/B', () => {
  for (const [value, answer] of [[true, '对'], ['√', '对'], ['错误', '错'], [false, '错']]) {
    assert.equal(runtime.answer(JSON.stringify({ kind: 'judgement', answer: value })).answer, answer);
  }
  assert.throws(() => runtime.answer('{"kind":"judgement","answer":"A"}'), { code: 'invalid_answer' });
});

test('JSON answer arrays preserve #include, C#, |, semicolons, and independent blanks', () => {
  const code = '#include <stdio.h>\nint main(){ return 1 | 2; }';
  const a = runtime.answer(JSON.stringify({ kind: 'subjective', answer: code }));
  assert.deepEqual(JSON.parse(a.answer), [code]);
  const blanks = runtime.answer('{"kind":"completion","answer":["C#","a|b;c"]}', { blankCount: 2 });
  assert.deepEqual(JSON.parse(blanks.answer), ['C#', 'a|b;c']);
  assert.throws(() => runtime.answer('{"kind":"completion","answer":["1"]}', { blankCount: 2 }), { code: 'invalid_answer' });
  assert.throws(() => runtime.answer('{"kind":"subjective","answer":["1","2"]}'), { code: 'invalid_answer' });
});

test('uncertainty, truncated output, tool calls, and reasoning-only answers are not returned', () => {
  assert.throws(() => runtime.answer('{"uncertain":true,"reason":"看不清"}'), { code: 'uncertain' });
  assert.throws(() => runtime.response('openai', openai({ answer: '2' }, 'length')), { code: 'incomplete_response' });
  assert.throws(() => runtime.response('openai', { choices: [{ message: { reasoning_content: '2' } }] }), { code: 'empty_response' });
  assert.throws(() => runtime.response('anthropic', { stop_reason: 'tool_use', content: [] }), { code: 'incomplete_response' });
  assert.equal(runtime.response('anthropic', { content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'final' }] }), 'final');
});

test('Chat Completions HTTP flow includes credentials, visual content, and a parsed choice answer', async () => {
  let calls = 0;
  await withMock((req, res, body) => {
    calls++;
    assert.equal(req.url, '/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    assert.equal(body.stream, false);
    assert.equal(body.thinking.type, 'disabled');
    const blocks = body.messages[1].content;
    assert.equal(blocks[2].type, 'image_url');
    assert.equal(blocks[2].image_url.url, PNG);
    res.end(JSON.stringify(openai({ kind: 'single', choices: ['B'], answer: '', uncertain: false })));
  }, async ({ base }) => {
    const input = { title: '图中符号是什么？ [图片1]', type: 'single', options: ['甲', '乙'], images: [PNG] };
    const result = await post(base, input);
    assert.equal(result.status, 200);
    assert.equal(result.data.answer, 'B');
    assert.equal(result.data.image_count, 1);
    const again = await post(base, input);
    assert.equal(again.data.cached, true);
    assert.equal(calls, 1);
  });
});

test('Claude Messages HTTP flow uses system, image source, API key, and version headers', async () => {
  await withMock((req, res, body) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'claude-test-key');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers['anthropic-version'], '2026-10-21');
    assert.equal(typeof body.system, 'string');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].content[2].source.media_type, 'image/png');
    res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"kind":"completion","answer":["3 V"],"uncertain":false}' }] }));
  }, async ({ base }) => {
    const result = await post(base, { title: '读出电压 [图片1]', type: 'completion', images: [PNG] });
    assert.deepEqual(JSON.parse(result.data.answer), ['3 V']);
    assert.equal(result.data.profile, 'claude');
  }, raw => { raw.profiles.claude.enabled = true; raw.routing.vision = ['claude']; });
});

test('OCS HEAD/GET probes succeed without key, make no model calls, and do not claim upstream verification', async () => {
  let calls = 0;
  await withMock((req, res) => { calls++; res.end('{}'); }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/answer?t=123`, { method: 'HEAD' })).status, 200);
    const health = await (await fetch(`${base}/api/answer?t=123`)).json();
    assert.equal(health.upstream_checked, false);
    assert.equal(health.profiles[0].apiKey, undefined);
    const denied = await post(base, { title: '1+1' }, 'bad');
    assert.equal(denied.status, 401);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal(calls, 0);
  });
});

test('real upstream 401 remains an actionable answer error and is not retried', async () => {
  let calls = 0;
  await withMock((req, res) => { calls++; res.writeHead(401); res.end('{"error":{"message":"sk-SHOULD_NOT_APPEAR"}}'); }, async ({ base }) => {
    const result = await post(base, { title: '1+1' });
    assert.equal(result.status, 200);
    assert.equal(result.data.code, 0);
    assert.equal(result.data.error.code, 'upstream_auth');
    assert.match(result.data.error.message, /鉴权失败/);
    assert.doesNotMatch(JSON.stringify(result.data), /SHOULD_NOT_APPEAR/);
    assert.equal(calls, 1);
  });
});

test('transient 503 retries once; 400 and uncertainty do not trigger formatting retries', async () => {
  let calls = 0;
  await withMock((req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(503); res.end('{}'); }
    else res.end(JSON.stringify(openai({ kind: 'completion', answer: ['2'] })));
  }, async ({ base }) => {
    assert.equal((await post(base, { title: '1+1' })).data.code, 1);
    assert.equal(calls, 2);
  });
  for (const [status, data] of [[400, {}], [200, openai({ uncertain: true, reason: '缺少材料' })]]) {
    calls = 0;
    await withMock((req, res) => { calls++; res.writeHead(status); res.end(JSON.stringify(data)); }, async ({ base }) => {
      assert.equal((await post(base, { title: '1+1' })).data.code, 0);
      assert.equal(calls, 1);
    });
  }
});

test('malformed objective answer receives one bounded formatting correction', async () => {
  let calls = 0;
  await withMock((req, res, body) => {
    calls++;
    if (calls === 1) res.end(JSON.stringify(openai({ kind: 'single', choices: ['Z'] })));
    else {
      assert.match(body.messages[1].content, /上一条响应格式/);
      res.end(JSON.stringify(openai({ kind: 'single', choices: ['A'] })));
    }
  }, async ({ base }) => {
    assert.equal((await post(base, { title: '请选择', type: 'single', options: ['甲', '乙'] })).data.answer, 'A');
    assert.equal(calls, 2);
  });
});

test('non-vision models are never used for an image question; profile requests cannot inject endpoints', async () => {
  let calls = 0;
  const solver = new Solver(config(raw => { raw.profiles.deepseek.vision = false; }), { fetchImpl: async () => { calls++; return response({}); } });
  await assert.rejects(solver.solve({ title: '看图', images: [PNG] }), { code: 'vision_unavailable' });
  await assert.rejects(solver.solve({ title: '1+1', profile: 'http://evil.example' }), { code: 'unknown_profile' });
  assert.equal(calls, 0);
});

test('explicit profile fallback can cross protocols', async () => {
  const calls = [];
  const c = config(raw => { raw.profiles.claude.enabled = true; raw.routing.text = ['deepseek', 'claude']; });
  const solver = new Solver(c, { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.model);
    if (url.includes('deepseek')) return response({}, 401);
    return response({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"kind":"completion","answer":["2"]}' }] });
  } });
  const result = await solver.solve({ title: '1+1' });
  assert.equal(result.profile, 'claude');
  assert.equal(calls.length, 2);
});

test('bounded concurrency and queue aborts release all resources', async () => {
  let active = 0, peak = 0;
  const c = config(raw => { raw.server.maxConcurrent = 1; raw.server.maxQueue = 1; });
  const solver = new Solver(c, { fetchImpl: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 35));
    active--;
    return response(openai({ kind: 'completion', answer: ['2'] }));
  } });
  const first = solver.solve({ title: 'question 1' });
  const controller = new AbortController();
  const queued = solver.solve({ title: 'question 2' }, { signal: controller.signal });
  await assert.rejects(solver.solve({ title: 'question 3' }), { code: 'busy' });
  controller.abort();
  await assert.rejects(queued, { code: 'timeout' });
  await first;
  assert.equal(peak, 1);
  assert.equal(solver.active, 0);
  assert.equal(solver.waiting.length, 0);
});

test('total timeout cancels upstream fetch, rather than leaving a background paid request running', async () => {
  const c = config(raw => { raw.server.totalTimeoutMs = 400; raw.server.attemptTimeoutMs = 500; });
  let aborted = false;
  const solver = new Solver(c, { fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  }) });
  // Keep this intentionally stalled mock alive until the AbortSignal timer fires.
  const keepAlive = setInterval(() => {}, 50);
  try { await assert.rejects(solver.solve({ title: 'slow question' }), { code: 'timeout' }); }
  finally { clearInterval(keepAlive); }
  assert.equal(aborted, true);
  assert.equal(solver.active, 0);
});

test('generated OCS configurations compile, reference image fields, and parse both protocols', () => {
  for (const id of ['deepseek', 'openai', 'claude']) {
    const profile = example.profiles[id];
    const aw = JSON.parse(JSON.stringify(directConfig(profile, id, 'PLACEHOLDER')))[0];
    const messages = Function(aw.data.messages.handler)()({ title: '[图片1]', type: 'single', options: '甲\n乙', images: [PNG] });
    assert.equal(messages.at(-1).role, 'user');
    const img = messages.at(-1).content.find(b => b.type === (profile.protocol === 'anthropic' ? 'image' : 'image_url'));
    assert.ok(img);
    const res = profile.protocol === 'anthropic' ? { content: [{ type: 'text', text: '{"kind":"single","choices":["B"]}' }] } : openai({ kind: 'single', choices: ['B'] });
    assert.equal(Function(aw.handler)()(res)[1], 'B');
    assert.match(aw.data.messages.handler, /images/);
  }
  const aw = bridgeConfig(TOKEN)[0];
  for (const value of Object.values(aw.data)) if (value.handler) assert.equal(typeof Function(value.handler)(), 'function');
  const result = Function(aw.handler)()({ code: 1, answer: 'AC', model: 'm', profile: 'p' });
  assert.equal(result[1], 'AC');
  assert.equal(result[2].ai, true);
  assert.throws(() => Function(aw.handler)()({ code: 0, error: { message: 'clear cause' } }), /clear cause/);
});

test('official OpenAI token parameter, Claude bearer mode, and custom body/header options remain configurable', async () => {
  const c = config(raw => {
    raw.profiles.deepseek = { ...raw.profiles.deepseek, protocol: 'anthropic', authStyle: 'bearer', extraHeaders: { 'anthropic-workspace-id': 'wrkspc_test' }, extraBody: { thinking: { type: 'disabled' } } };
  });
  const solver = new Solver(c, { fetchImpl: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.headers['anthropic-workspace-id'], 'wrkspc_test');
    return response({ content: [{ type: 'text', text: '{"kind":"completion","answer":["2"]}' }] });
  } });
  assert.equal((await solver.solve({ title: '1+1' })).code, 1);
  const body = runtime.request(example.profiles.openai, runtime.normalize({ title: '1+1' }));
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.temperature, undefined);
  assert.throws(() => config(raw => { raw.profiles.deepseek.extraBody = { stream: true }; }), /stream/);
  assert.throws(() => config(raw => { raw.profiles.deepseek.extraHeaders = { Authorization: 'leak' }; }), /Authorization/);
});

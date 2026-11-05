import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { WorkspaceDB } from './lib/database.mjs';
import { chinaClock } from './lib/pricing.mjs';
import { Solver } from './lib/solver.mjs';
import { BridgeError, redact, listModels } from './lib/providers.mjs';
import { initializeFiles } from './lib/store.mjs';
import { bridgeConfig } from './lib/ocs.mjs';

export const VERSION = '3.0.1';
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/features.js', ['features.js', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']]
]);
const answerPaths = new Set(['/api/answer', '/api/answer/lite', '/api/answer/full']);
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function authorized(req, token) {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const hash = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(value.slice(7)), hash(token));
}
async function body(req, maxBytes) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new BridgeError('content_type', '请使用 Content-Type: application/json。', 415);
  if (Number(req.headers['content-length'] || 0) > maxBytes) throw new BridgeError('body_too_large', '请求体超过接口大小上限。', 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) throw new BridgeError('body_too_large', '请求体超过接口大小上限。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('invalid_json', '请求体不是有效 JSON。', 400); }
}

export function createBridgeServer(initialConfig, { fetchImpl = fetch, log = () => {}, store = null } = {}) {
  let config = initialConfig;
  const database = new WorkspaceDB(store?.root || null,config.token);
  let solver = new Solver(config, { fetchImpl, log, database });
  const retired = new Set();
  const history = [];
  const stats = { requests: 0, success: 0, failed: 0, cached: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, total_ms: 0 };
  const instanceId = createHash('sha256').update(config.token + (store?.root || '')).digest('hex').slice(0, 16);
  const activeSolvers = () => { for (const item of retired) if (!item.active && !item.waiting.length) retired.delete(item); return [solver, ...retired]; };
  const health = () => ({
    status: 'running', service: 'ocs-ai-bridge', version: VERSION, ui: !!store, instance_id: instanceId,
    upstream_checked: false, ready: Object.values(config.profiles).some(p => p.enabled && (p.apiKey || p.authStyle === 'none')),
    configured_profiles: Object.values(config.profiles).filter(p => p.enabled && (p.apiKey || p.authStyle === 'none')).length,
    active: activeSolvers().reduce((sum, item) => sum + item.active, 0), queued: activeSolvers().reduce((sum, item) => sum + item.waiting.length, 0),
    profiles: Object.values(config.profiles).filter(p => p.enabled).map(p => ({ id: p.id, protocol: p.protocol, model: p.model, vision: p.vision, configured: !!p.apiKey || p.authStyle === 'none' }))
  });
  function record(input, value, started) {
    const success = value.code === 1;
    const usage = value.usage || { reported: false, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const ms = Date.now() - started;
    stats.requests++; stats[success ? 'success' : 'failed']++;
    stats.cached += value.cached ? 1 : 0;
    for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) stats[field] += usage[field] || 0;
    stats.total_ms += ms;
    history.unshift({ at: new Date().toISOString(), question: redact(String(input?.title || input?.question || '').replace(/data:image\/[^\s"']+/g, '[图片]').slice(0, 180)),
      success, profile: value.profile || input?.profile || '', mode: value.mode || input?.mode || config.answering.mode,
      cached: !!value.cached, elapsed_ms: ms, usage, error_code: value.error?.code || '' });
    if (history.length > 200) history.pop();
  }
    async function execute(input, req, res, requestId, started, device=null) {
    if(!input || typeof input!=='object' || Array.isArray(input)) throw new BridgeError('invalid_question','请求体必须是 JSON 对象。',400);
    const socketIP=(req.socket.remoteAddress||'').replace(/^::ffff:/,'');
    const ip=config.network.trustedProxies.includes(socketIP) && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',').at(-1).trim() : socketIP;
    if(device?.settings.profiles.length) {
      if(input.profile && !device.settings.profiles.includes(input.profile)) throw new BridgeError('device_profile','此设备无权使用指定模型。',403);
      if(!input.profile) input.profile=device.settings.profiles.find(id=>config.profiles[id]?.enabled && (!input.images?.length || config.profiles[id].vision)) || device.settings.profiles[0];
    }
    const identity=database.admit(device,ip,requestId);
    const cancel = new AbortController();
    const onClose = () => { if (!res.writableEnded) cancel.abort(); };
    res.on('close', onClose);
    let value;
    try { value = await solver.solve(input, { signal: cancel.signal, requestId }); }
    catch (error) {
      value = { code: 0, success: false, request_id: requestId, usage: error.usage, cost:error.cost, model_calls: error.model_calls,
        error: { code: error.code || 'request_failed', message: redact(error.message || '请求失败。'), http_status: error.status || 422 }, ...(error.failures ? { attempts: error.failures } : {}) };
      log({ request_id: requestId, status: 'error', code: error.code || 'request_failed', elapsed_ms: Date.now() - started });
    } finally { res.removeListener('close', onClose); }
    record(input, value, started);
    database.finish(requestId,identity,value);
    json(res, 200, value);
  }
  function sameOrigin(req) {
    if (!req.headers.origin) return;
    let origin;
    try { origin = new URL(req.headers.origin); } catch { /* invalid */ }
    if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) throw new BridgeError('origin', '管理接口仅接受同源请求。', 403);
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch { throw new BridgeError('invalid_url', '无效请求地址。', 400); }
      if (['127.0.0.1', 'localhost', '::1'].includes(initialConfig.server.host)) {
        let host;
        try { host = new URL(`http://${req.headers.host || ''}`).hostname; } catch { /* invalid */ }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new BridgeError('invalid_host', '本机接口只接受 localhost/127.0.0.1 访问。', 403);
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, mime] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(readFileSync(new URL('./web/' + file, import.meta.url))); return;
      }
      if (['GET', 'HEAD'].includes(req.method) && (url.pathname === '/health' || answerPaths.has(url.pathname))) {
        if (req.method === 'HEAD') { res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end(); }
        else json(res, 200, health());
        return;
      }
      if (url.pathname.startsWith('/admin/')) {
        sameOrigin(req);
        if (!authorized(req, config.token)) throw new BridgeError('bridge_auth', '本机访问 token 不匹配，请从 start.cmd 重新打开控制台。', 401);
        if (req.method === 'GET' && url.pathname === '/admin/state') { json(res, 200, { ...health(), stats: { ...stats, average_ms: stats.requests ? stats.total_ms / stats.requests : 0 }, history }); return; }
        if (req.method==='GET' && url.pathname==='/admin/analytics') { json(res,200,database.analytics(url.searchParams.get('day')||chinaClock().day)); return; }
        if (req.method==='GET' && url.pathname==='/admin/network') {
          const addresses=Object.values(networkInterfaces()).flat().filter(x=>x && !x.internal && x.family==='IPv4').map(x=>`http://${x.address}:${config.server.port}`);
          json(res,200,{host:config.server.host,addresses,publicBase:config.network.publicBase,timezone:'Asia/Shanghai'});return;
        }
        if (url.pathname==='/admin/devices') {
          if(req.method==='GET') {json(res,200,{items:database.devices()});return;}
          if(req.method==='POST') {const value=await body(req,65536); if(value.settings?.profiles?.some(id=>!config.profiles[id])) throw new BridgeError('device_profile','设备模型不存在。',400); json(res,200,database.saveDevice(value));return;}
        }
        const deviceId=url.pathname.match(/^\/admin\/devices\/([a-f0-9-]+)$/)?.[1];
        if(deviceId && req.method==='PUT') {const value=await body(req,65536);if(value.settings?.profiles?.some(id=>!config.profiles[id])) throw new BridgeError('device_profile','设备模型不存在。',400);json(res,200,database.saveDevice(value,deviceId));return;}
        if (url.pathname==='/admin/questions') {
          if(req.method==='GET') {json(res,200,database.listQuestions(url.searchParams.get('q')||'',url.searchParams.get('page'),url.searchParams.get('kind')||''));return;}
          if(req.method==='POST') {json(res,200,database.saveQuestion(await body(req,config.server.maxBodyBytes)));activeSolvers().forEach(s=>s.cache.clear());return;}
        }
        const questionId=url.pathname.match(/^\/admin\/questions\/(\d+)$/)?.[1];
        if(questionId) {
          if(req.method==='GET') {json(res,200,database.question(Number(questionId)));return;}
          if(req.method==='PUT') {json(res,200,database.saveQuestion(await body(req,config.server.maxBodyBytes),Number(questionId)));activeSolvers().forEach(s=>s.cache.clear());return;}
          if(req.method==='DELETE') {database.removeQuestion(Number(questionId));activeSolvers().forEach(s=>s.cache.clear());json(res,200,{success:true});return;}
        }
        if (req.method === 'GET' && url.pathname === '/admin/config') {
          if (!store) throw new BridgeError('no_store', '当前运行模式没有配置存储。', 503);
          json(res, 200, store.publicConfig()); return;
        }
        if (req.method === 'PUT' && url.pathname === '/admin/config') {
          if (!store) throw new BridgeError('no_store', '当前运行模式没有配置存储。', 503);
          const value = await body(req, 1024 ** 2);
          const result = store.save(value);
          retired.add(solver); config = store.config; solver = new Solver(config, { fetchImpl, log, database });
          store.exportFiles(`http://${req.headers.host}`);
          json(res, 200, result); return;
        }
        if (req.method === 'GET' && url.pathname === '/admin/ocs-config') {
          const mode = url.searchParams.get('mode') || 'auto';
          const profile = url.searchParams.get('profile') || '';
          if (!['auto', 'lite', 'full'].includes(mode) || profile && !Object.hasOwn(config.profiles, profile)) throw new BridgeError('bad_export', '导出模式或接口标识无效。', 400);
          const base = new URL(url.searchParams.get('base') || `http://${req.headers.host}`);
          if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new BridgeError('bad_export', '请填写不带路径的 HTTP(S) 服务根地址。', 400);
          const id=url.searchParams.get('device');
          if(!id && !['localhost','127.0.0.1','[::1]'].includes(base.hostname)) throw new BridgeError('device_required','给其他设备导出时，请先选择独立设备令牌。',400);
          if(id) {const item=database.devices().find(x=>x.id===id);if(!item?.settings.enabled) throw new BridgeError('device_denied','设备不存在或已停用。',403);if(profile && item.settings.profiles.length && !item.settings.profiles.includes(profile)) throw new BridgeError('device_profile','设备没有该模型权限。',403);}
          json(res, 200, bridgeConfig(id?database.deviceToken(id):config.token, base.origin, profile, mode)); return;
        }
        if (req.method === 'GET' && url.pathname === '/admin/models') {
          const profile = config.profiles[url.searchParams.get('profile')];
          if (!profile || !profile.apiKey && profile.authStyle !== 'none') throw new BridgeError('profile_not_ready', '请先保存接口和 API Key。', 400);
          const models = await listModels(profile, fetchImpl);
          json(res, 200, { models }); return;
        }
        if (req.method === 'POST' && url.pathname === '/admin/cache/clear') { activeSolvers().forEach(item => item.cache.clear()); json(res, 200, { success: true }); return; }
        if (req.method === 'POST' && url.pathname === '/admin/test') { const input = await body(req, config.server.maxBodyBytes); await execute({...input,use_database:input.use_database===true}, req, res, requestId, started); return; }
        throw new BridgeError('not_found', '管理接口不存在或请求方式不正确。', 404);
      }
      if (!answerPaths.has(url.pathname)) throw new BridgeError('not_found', '接口不存在。', 404);
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST, GET, HEAD'); throw new BridgeError('method', '搜题请使用 POST。', 405); }
      let device=null;
      if (!authorized(req, config.token)) {device=database.identify(String(req.headers.authorization||'').replace(/^Bearer /,'')); if(!device) throw new BridgeError('bridge_auth', '接口 token 不匹配，请使用新导出的 OCS 配置。', 401);}
      const input = await body(req, config.server.maxBodyBytes);
      if (url.pathname !== '/api/answer') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BridgeError('invalid_question', '请求体必须是 JSON 对象。', 400);
        input.mode = url.pathname.endsWith('/lite') ? 'lite' : 'full';
      }
      await execute(input, req, res, requestId, started,device);
    } catch (error) { json(res, error.status || (error.code?.startsWith('SQLITE')?400:500), { code: 0, success: false, request_id: requestId, error: { code: error.code || 'internal_error', message: error.code?.startsWith('SQLITE')?'数据库写入失败，题目可能重复或字段无效。':redact(error.message || '接口内部错误。') } }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.once('close',()=>database.close());
  return { server, get solver() { return solver; }, health, database };
}

export function startServer(config, options = {}) {
  const store = options.store || (!config ? initializeFiles() : null);
  const current = config || store.config;
  const { server } = createBridgeServer(current, { ...options, store, log: value => console.log(JSON.stringify(value)) });
  server.on('error', error => { console.error(redact(error.message)); process.exitCode = 1; });
  server.listen(current.server.port, current.server.host, () => console.log(`OCS AI v${VERSION}: http://127.0.0.1:${current.server.port}/`));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { startServer(); } catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}

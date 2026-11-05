import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv(path, env = process.env) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!match || Object.hasOwn(env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[match[1]] = value;
  }
}

export function validateConfig(config, env = process.env) {
  if (!config?.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles)) throw new Error('config.json 缺少 profiles。');
  const server = {
    host: '127.0.0.1', port: 8765, tokenEnv: 'OCS_BRIDGE_TOKEN', totalTimeoutMs: 50000,
    attemptTimeoutMs: 24000, maxConcurrent: 2, maxQueue: 8, maxBodyBytes: 32 * 1024 ** 2,
    cacheEntries: 100, cacheTtlMs: 900000, ...config.server
  };
  for (const key of ['port', 'totalTimeoutMs', 'attemptTimeoutMs', 'maxConcurrent', 'maxBodyBytes', 'cacheTtlMs']) {
    if (!Number.isInteger(server[key]) || server[key] < 1) throw new Error(`server.${key} 必须是正整数。`);
  }
  for (const key of ['maxQueue', 'cacheEntries']) if (!Number.isInteger(server[key]) || server[key] < 0) throw new Error(`server.${key} 必须为非负整数。`);
  if (server.port > 65535 || server.totalTimeoutMs > 55000) throw new Error('端口不能超过 65535；totalTimeoutMs 不能超过 55000，以留出 OCS 60 秒超时前的返回时间。');
  const token = env[server.tokenEnv] || '';
  if (token.length < 24 || /^REPLACE_|替换|YOUR_/i.test(token)) throw new Error('未设置有效 OCS_BRIDGE_TOKEN，请通过 start.cmd 初始化。');
  const profiles = {};
  for (const [id, value] of Object.entries(config.profiles)) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(id)) throw new Error(`无效模型配置名：${id}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`profiles.${id} 必须是对象。`);
    if (!['openai', 'anthropic'].includes(value.protocol)) throw new Error(`${id}: protocol 只能是 openai 或 anthropic。`);
    let endpoint;
    try { endpoint = new URL(value.endpoint); } catch { throw new Error(`${id}: endpoint 必须是完整接口 URL。`); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error(`${id}: endpoint 应为不含查询参数、账号密码的 HTTP(S) URL。`);
    if (!value.model || typeof value.model !== 'string') throw new Error(`${id}: model 不能为空。`);
    if (value.authStyle !== 'none' && !/^[A-Z_][A-Z0-9_]*$/i.test(value.apiKeyEnv || '')) throw new Error(`${id}: apiKeyEnv 必须是有效环境变量名。`);
    if (value.tokenParameter && !['max_tokens', 'max_completion_tokens'].includes(value.tokenParameter)) throw new Error(`${id}: tokenParameter 不受支持。`);
    if (value.systemRole && !['system', 'developer'].includes(value.systemRole)) throw new Error(`${id}: systemRole 只能为 system/developer。`);
    if (value.maxTokens != null && (!Number.isInteger(value.maxTokens) || value.maxTokens < 1)) throw new Error(`${id}: maxTokens 必须是正整数。`);
    if (value.authStyle && !['x-api-key', 'bearer', 'none'].includes(value.authStyle)) throw new Error(`${id}: authStyle 不受支持。`);
    for (const field of ['extraBody', 'extraHeaders', 'liteBody']) {
      if (value[field] != null && (typeof value[field] !== 'object' || Array.isArray(value[field]))) throw new Error(`${id}: ${field} 必须是对象。`);
    }
    for (const key of ['model', 'messages', 'system', 'stream', 'max_tokens', 'max_completion_tokens']) {
      if (Object.hasOwn(value.extraBody || {}, key) || Object.hasOwn(value.liteBody || {}, key)) throw new Error(`${id}: extraBody/liteBody 不允许覆盖 ${key}；请使用对应配置项。`);
    }
    for (const key of Object.keys(value.extraHeaders || {})) {
      if (/^(authorization|x-api-key|host|content-length|content-type)$/i.test(key)) throw new Error(`${id}: extraHeaders 不允许覆盖 ${key}，鉴权请使用 apiKeyEnv/authStyle。`);
    }
    const apiKey = (env[value.apiKeyEnv] || '').trim();
    profiles[id] = { ...value, id, endpoint: endpoint.toString(), apiKey, enabled: value.enabled === true, vision: value.vision === true };
  }
  const routing = { text: [], vision: [], multiple: [], subjective: [], ...config.routing };
  for (const [name, list] of Object.entries(routing)) {
    if (!Array.isArray(list) || list.some(id => !Object.hasOwn(profiles, id))) throw new Error(`routing.${name} 必须是已定义的 profile 名称数组。`);
  }
  const limits = { maxImages: 20, maxImageBytes: 5 * 1024 ** 2, maxTotalImageBytes: 20 * 1024 ** 2, maxTextChars: 100000, ...config.limits };
  for (const [key, value] of Object.entries(limits)) if (!Number.isInteger(value) || value < 1) throw new Error(`limits.${key} 必须是正整数。`);
  const answering = { mode: 'auto', objectiveTokens: 32, maxTokens: 512, liteAttempts: 1, ...config.answering };
  if (!['auto', 'lite', 'full'].includes(answering.mode)) throw new Error('answering.mode 只能是 auto、lite 或 full。');
  for (const key of ['objectiveTokens', 'maxTokens', 'liteAttempts']) if (!Number.isInteger(answering[key]) || answering[key] < 1) throw new Error(`answering.${key} 必须是正整数。`);
  if (answering.liteAttempts > 2) throw new Error('liteAttempts 最多为 2。');
  for (const [id, profile] of Object.entries(profiles)) for (const key of ['liteObjectiveTokens', 'liteMaxTokens']) {
    if (profile[key] != null && (!Number.isInteger(profile[key]) || profile[key] < 1)) throw new Error(`${id}: ${key} 必须是正整数。`);
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ profiles, routing, limits, answering })).digest('hex');
  return { server, profiles, routing, limits, answering, token, fingerprint };
}

export function readConfig(root = projectRoot, env = process.env) {
  const localEnv = {};
  loadDotEnv(resolve(root, '.env'), localEnv);
  const combinedEnv = { ...env, ...localEnv };
  const path = resolve(root, 'config.json');
  if (!existsSync(path)) throw new Error('请先运行 node setup.mjs，或把 config.example.json 复制为 config.json。');
  return validateConfig(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')), combinedEnv);
}

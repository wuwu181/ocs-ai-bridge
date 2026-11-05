export class BridgeError extends Error {
  constructor(code, message, status = 502, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

export function redact(value) {
  return String(value).replace(/sk-[A-Za-z0-9_-]+/g, '[KEY_REDACTED]').replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]');
}

const explanations = {
  400: ['upstream_parameters', '模型拒绝了请求参数，请核对模型、图片能力及 extraBody。'],
  401: ['upstream_auth', '模型接口鉴权失败，请核对对应 apiKeyEnv、密钥和服务商 endpoint。'],
  402: ['upstream_balance', '模型接口余额或配额不足。'],
  403: ['upstream_permission', '模型接口拒绝访问，请检查模型权限或服务商访问限制。'],
  404: ['upstream_not_found', '模型或接口路径不存在，请填写完整 endpoint 和正确模型 ID。'],
  413: ['upstream_too_large', '模型接口认为图片或请求体过大，请压缩后重试。'],
  422: ['upstream_parameters', '模型不支持当前参数或图片格式。'],
  429: ['upstream_rate_limit', '模型接口限流，请降低 OCS 并发或稍后重试。']
};

export function providerHeaders(profile) {
  const headers = { ...profile.extraHeaders, 'Content-Type': 'application/json' };
  const authStyle = profile.authStyle || (profile.protocol === 'anthropic' ? 'x-api-key' : 'bearer');
  if (authStyle === 'x-api-key') headers['x-api-key'] = profile.apiKey;
  else if (authStyle !== 'none') headers.Authorization = `Bearer ${profile.apiKey}`;
  if (profile.protocol === 'anthropic') headers['anthropic-version'] = profile.anthropicVersion || '2026-10-21';
  return headers;
}

export async function listModels(profile, fetchImpl = fetch) {
  const url = new URL(profile.endpoint);
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|messages)\/?$/, '/models');
  const response = await fetchImpl(url, { headers: providerHeaders(profile), redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BridgeError('model_list_failed', `模型列表查询返回 HTTP ${response.status}。该接口可能不支持列表查询，也可手工填写模型 ID 后试答。`, 502);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > 1024 ** 2) throw new BridgeError('models_too_large', '模型列表响应过大。', 502);
    chunks.push(Buffer.from(chunk));
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('models_invalid_json', '模型列表接口没有返回有效 JSON。', 502); }
  return (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []).map(item => typeof item === 'string' ? item : item.id || item.name).filter(value => typeof value === 'string').slice(0, 500);
}

export async function callProvider(profile, body, { fetchImpl = fetch, signal, timeoutMs = 24000 } = {}) {
  const headers = providerHeaders(profile);
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]) : AbortSignal.timeout(Math.max(1, timeoutMs));
  let res;
  try {
    res = await fetchImpl(profile.endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: abort, redirect: 'error' });
  } catch (error) {
    if (signal?.aborted) throw new BridgeError('timeout', '请求已取消或超过总超时预算。', 504);
    if (abort.aborted) throw new BridgeError('upstream_timeout', '模型接口响应超时，请降低并发、关闭深度思考或选择更快的模型。', 504, { retryable: true });
    throw new BridgeError('upstream_network', '无法连接模型接口，请检查网络、代理和 endpoint。', 502, { retryable: true });
  }
  // Limit both successful and failed responses; never log upstream keys or raw bodies.
  let responseText = '';
  let size = 0;
  const chunks = [];
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > 2 * 1024 ** 2) {
          throw new BridgeError('upstream_response_too_large', '模型响应超过 2 MiB 上限。');
        }
        chunks.push(Buffer.from(chunk));
      }
    }
    responseText = Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('upstream_read_error', '读取模型响应失败或超时。', 502, { retryable: true });
  }
  let data;
  try { data = JSON.parse(responseText); } catch { /* status is still meaningful for an HTML error page. */ }
  if (!res.ok) {
    const [code, message] = explanations[res.status] || ['upstream_error', `模型接口返回 HTTP ${res.status}。`];
    const retryAfter = res.headers.get('retry-after');
    const retryMs = retryAfter ? Math.max(0, Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
    throw new BridgeError(code, message, res.status, { retryable: res.status === 429 || res.status >= 500, retryMs });
  }
  if (!data || typeof data !== 'object') throw new BridgeError('upstream_invalid_json', '模型接口没有返回 JSON，可能使用了错误路径、登录页面或流式接口。');
  return data;
}

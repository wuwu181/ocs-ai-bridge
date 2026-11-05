import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime } from './portable.mjs';
import { BridgeError, callProvider } from './providers.mjs';
import { answerMode, liteRequest, liteAnswer, usageOf } from './lite.mjs';

const runtime = createRuntime();
const repairCodes = new Set(['invalid_answer', 'empty_answer']);

export function selectProfiles(config, q, requested) {
  let ids;
  if (requested != null && requested !== '') {
    if (typeof requested !== 'string' || !Object.hasOwn(config.profiles, requested)) throw new BridgeError('unknown_profile', '指定的 profile 不存在。', 400);
    ids = [requested];
  } else if (q.images.length) ids = config.routing.vision;
  else if (q.kind === 'multiple' && config.routing.multiple.length) ids = config.routing.multiple;
  else if (q.kind === 'subjective' && config.routing.subjective.length) ids = config.routing.subjective;
  else ids = config.routing.text;
  const candidates = Array.from(new Set(ids)).map(id => config.profiles[id]).filter(p => p?.enabled && (p.apiKey || p.authStyle === 'none'));
  const selected = q.images.length ? candidates.filter(p => p.vision) : candidates;
  if (!selected.length) throw new BridgeError(q.images.length ? 'vision_unavailable' : 'provider_unconfigured',
    q.images.length ? '没有可用的视觉模型。请为 routing.vision 配置已启用、已设置密钥且 vision:true 的模型。' : '没有可用模型。请设置对应 API Key、enabled:true 和 routing.text。', 503);
  return selected;
}

export class Solver {
  constructor(config, { fetchImpl = fetch, log = () => {} } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.cache = new Map();
    this.active = 0;
    this.waiting = [];
  }
  async acquire(signal) {
    if (signal.aborted) throw new BridgeError('timeout', '请求超过总超时预算。', 504);
    if (this.active < this.config.server.maxConcurrent) { this.active++; return; }
    if (this.waiting.length >= this.config.server.maxQueue) throw new BridgeError('busy', '接口排队已满，请降低 OCS 并发后重试。', 429);
    await new Promise((resolve, reject) => {
      const item = { resolve: () => { signal.removeEventListener('abort', cancel); resolve(); } };
      const cancel = () => {
        const index = this.waiting.indexOf(item);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new BridgeError('timeout', '排队超过总超时预算，请降低 OCS 并发。', 504));
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.waiting.push(item);
    });
  }
  release() {
    const item = this.waiting.shift();
    if (item) item.resolve();
    else this.active--;
  }
  async solve(input, { signal, requestId } = {}) {
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.config.server.totalTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const q = runtime.normalize(input, this.config.limits);
    const mode = answerMode(input, q, this.config.answering);
    if (mode === 'lite' && q.images.length) throw new BridgeError('lite_text_only', '省 Token 模式仅支持文字题，请改用自动或完整模式。', 422);
    const profiles = selectProfiles(this.config, q, input.profile);
    const key = createHash('sha256').update(JSON.stringify({ signature: this.config.fingerprint, q, mode, profiles: profiles.map(p => p.id) })).digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return { ...cached.value, cached: true, usage: { reported: true, input_tokens: 0, output_tokens: 0, total_tokens: 0 }, model_calls: 0, request_id: requestId, elapsed_ms: Date.now() - started };
    this.cache.delete(key);
    await this.acquire(combined);
    try {
      let lastError;
      const failures = [];
      const usage = { reported: false, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      let modelCalls = 0;
      const timeoutError = () => new BridgeError('timeout', '请求已取消或超过总超时预算。', 504, { usage, model_calls: modelCalls });
      for (const profile of profiles) {
        let repair = false;
        const maxAttempts = mode === 'lite' ? this.config.answering.liteAttempts : 2;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const remaining = this.config.server.totalTimeoutMs - (Date.now() - started);
          if (combined.aborted || remaining < 300) throw timeoutError();
          try {
            const body = mode === 'lite' ? liteRequest(profile, q, this.config.answering) : runtime.request(profile, q, repair);
            modelCalls++;
            const data = await callProvider(profile, body, { fetchImpl: this.fetchImpl, signal: combined, timeoutMs: Math.min(remaining, this.config.server.attemptTimeoutMs) });
            const currentUsage = usageOf(profile.protocol, data);
            usage.reported ||= currentUsage.reported;
            for (const field of ['input_tokens', 'output_tokens', 'total_tokens']) usage[field] += currentUsage[field];
            const raw = runtime.response(profile.protocol, data);
            const result = mode === 'lite' ? liteAnswer(raw, q) : runtime.answer(raw, q);
            const value = {
              code: 1, success: true, question: q.rawTitle, ...result, profile: profile.id,
              model: profile.model, protocol: profile.protocol, image_count: q.images.length,
              mode, usage, model_calls: modelCalls, cached: false, elapsed_ms: Date.now() - started, request_id: requestId
            };
            if (this.config.server.cacheEntries && JSON.stringify(value).length <= 131072) {
              this.cache.set(key, { expires: Date.now() + this.config.server.cacheTtlMs, value });
              while (this.cache.size > this.config.server.cacheEntries) this.cache.delete(this.cache.keys().next().value);
            }
            this.log({ request_id: requestId, profile: profile.id, kind: result.kind, images: q.images.length, elapsed_ms: value.elapsed_ms, status: 'ok' });
            return value;
          } catch (error) {
            lastError = error;
            error.usage = usage;
            error.model_calls = modelCalls;
            failures.push({ profile: profile.id, code: error.code || 'upstream_error' });
            if (combined.aborted || Date.now() - started >= this.config.server.totalTimeoutMs ||
                (error.code === 'upstream_timeout' && remaining <= this.config.server.attemptTimeoutMs)) {
              throw timeoutError();
            }
            // Invalid formatting gets one correction; uncertainty/refusal never gets guessed away.
            if (attempt === 0 && repairCodes.has(error.code)) { repair = true; continue; }
            const wait = Math.min(Math.max(error.retryMs || 350, 100), 5000);
            const budget = this.config.server.totalTimeoutMs - (Date.now() - started);
            if (attempt === 0 && error.retryable && wait + 500 < budget && (error.retryMs || 0) <= 5000) {
              try { await delay(wait, undefined, { signal: combined }); }
              catch { throw timeoutError(); }
              continue;
            }
            break;
          }
        }
      }
      if (!lastError) throw new BridgeError('no_answer', '没有模型返回可用答案。', 503);
      lastError.failures = failures;
      throw lastError;
    } finally { this.release(); }
  }
}

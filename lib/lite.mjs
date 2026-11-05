import { createRuntime } from './portable.mjs';
import { BridgeError } from './providers.mjs';

const runtime = createRuntime();
export function answerMode(input, question, settings = {}) {
  const selected = input.mode || settings.mode || 'auto';
  if (!['auto', 'lite', 'full'].includes(selected)) throw new BridgeError('invalid_mode', 'mode 只能是 auto、lite 或 full。', 400);
  if (selected !== 'auto') return selected;
  return question.images.length || /证明|推导|论述|编程|设计题/.test(question.title) ? 'full' : 'lite';
}

export function liteRequest(profile, q, settings = {}) {
  if (q.images.length) throw new BridgeError('lite_text_only', '省 Token 模式仅支持文字题，请切换自动或完整模式。', 422);
  const rules = {
    single: '单选仅答一个大写字母。',
    multiple: '多选仅答全部正确字母，升序连写，如ACD。',
    judgement: '判断仅答对或错，禁止输出选项字母A/B。'
  };
  const rule = rules[q.kind] || '填空答JSON数组，每空一项；解答题仅用一项简明作答，计算保留必要公式和结果。';
  const system = '准确答题。' + rule + '不确定仅答未知。';
  const content = q.title + (q.promptOptions.length ? '\n' + q.promptOptions.join('\n') : '');
  const body = { ...profile.extraBody, ...profile.liteBody, model: profile.model, stream: false };
  delete body.response_format;
  const tokens = rules[q.kind] ? (profile.liteObjectiveTokens || settings.objectiveTokens || 32) : (profile.liteMaxTokens || settings.maxTokens || 512);
  if (profile.protocol === 'anthropic') {
    body.system = system;
    body.messages = [{ role: 'user', content }];
    body.max_tokens = tokens;
  } else {
    body.messages = [{ role: profile.systemRole || 'system', content: system }, { role: 'user', content }];
    body[profile.tokenParameter || 'max_tokens'] = tokens;
  }
  if (profile.temperature != null) body.temperature = profile.temperature;
  return body;
}

export function liteAnswer(raw, q) {
  const value = String(raw).trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  if (/^(未知|无法确定|不确定)[。.!！]?$/.test(value)) throw new BridgeError('uncertain', '模型无法可靠确定答案，请人工核对。', 422);
  let parsed;
  try { parsed = JSON.parse(value); } catch { /* Plain letters or a short textual answer are valid. */ }
  if (Array.isArray(parsed)) {
    const kind = q.kind === 'subjective' ? 'subjective' : 'completion';
    if (parsed.some(x => !['string', 'number'].includes(typeof x))) throw new BridgeError('invalid_answer', '模型返回的答案数组格式无效。', 422);
    const answers = parsed.map(String);
    if (kind === 'subjective' && answers.length !== 1) throw new BridgeError('invalid_answer', '解答题应返回一项完整答案。', 422);
    return runtime.answer(JSON.stringify({ kind, answer: kind === 'subjective' ? answers[0] : answers }), q);
  }
  return runtime.answer(value, q);
}

export function usageOf(protocol, data) {
  const usage = data?.usage;
  if (!usage || !['prompt_tokens','input_tokens','completion_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].some(key => usage[key] != null && Number.isFinite(Number(usage[key])))) {
    return { reported: false, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const input = protocol === 'anthropic'
    ? number(usage.input_tokens) + number(usage.cache_read_input_tokens) + number(usage.cache_creation_input_tokens)
    : number(usage.prompt_tokens ?? usage.input_tokens);
  const output = number(usage.completion_tokens ?? usage.output_tokens);
  return { reported: true, input_tokens: input, output_tokens: output, total_tokens: input + output,
    cache_hit_tokens: number(usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    cache_split_reported: usage.prompt_cache_hit_tokens != null || usage.cache_read_input_tokens != null || usage.prompt_tokens_details?.cached_tokens != null };
}

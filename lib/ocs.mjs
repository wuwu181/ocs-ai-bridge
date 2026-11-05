import { createRuntime } from './portable.mjs';

export function bridgeConfig(token, baseUrl = 'http://127.0.0.1:8765', profile = '', mode = 'auto') {
  const base = baseUrl.replace(/\/$/, '');
  return [{
    name: `统一AI题库-${mode === 'lite' ? '省Token' : mode === 'full' ? '完整多模态' : '自动'}`, homepage: `${base}/health`, url: `${base}/api/answer${mode === 'auto' ? '' : '/' + mode}`,
    method: 'post', type: 'GM_xmlhttpRequest', contentType: 'json',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    data: {
      title: { handler: "return (env)=>String(env.title||'');" },
      type: { handler: "return (env)=>String(env.type||'unknown');" },
      options: { handler: "return (env)=>env.options||'';" },
      ...(mode !== 'lite' ? {
        images: { handler: 'return (env)=>Array.isArray(env.images)?env.images:[];' },
        suggestion_title: { handler: "return (env)=>String(env.suggestion_title||'');" },
        suggestion_options: { handler: "return (env)=>env.suggestion_options||'';" }
      } : {}),
      ...(profile ? { profile } : {})
    },
    handler: "return (res)=>{if(!res||res.code!==1){var e=res&&res.error;throw new Error(e&&e.message||res&&res.message||'统一接口没有返回答案');}if(typeof res.answer!=='string'||!res.answer.trim())return undefined;return [undefined,res.answer,{ai:true,cache:res.cached===true,model:res.model,provider:res.profile}];}"
  }];
}

export function directConfig(profile, name, keyPlaceholder) {
  const runtime = `(${createRuntime.toString()})()`;
  const profileCode = JSON.stringify(profile);
  const messages = `return (env)=>{var r=${runtime};return r.request(${profileCode},r.normalize(env)).messages;}`;
  const instance = createRuntime();
  const data = { model: profile.model, stream: false, messages: { handler: messages } };
  Object.assign(data, profile.extraBody || {});
  if (profile.protocol === 'anthropic') {
    data.system = instance.prompt(instance.normalize({ title: 'placeholder' })).system;
    data.max_tokens = profile.maxTokens || 4096;
  } else {
    data[profile.tokenParameter || 'max_tokens'] = profile.maxTokens || 4096;
    if (profile.jsonMode) data.response_format = { type: 'json_object' };
  }
  if (profile.temperature != null) data.temperature = profile.temperature;
  const headers = { ...profile.extraHeaders, 'Content-Type': 'application/json' };
  if (profile.protocol === 'anthropic') {
    headers['x-api-key'] = keyPlaceholder;
    headers['anthropic-version'] = profile.anthropicVersion || '2026-10-21';
  } else headers.Authorization = `Bearer ${keyPlaceholder}`;
  return [{
    name, homepage: new URL(profile.endpoint).origin, url: profile.endpoint,
    method: 'post', type: 'GM_xmlhttpRequest', contentType: 'json', headers, data,
    handler: `return (res)=>{var r=${runtime};var a=r.answer(r.response(${JSON.stringify(profile.protocol)},res));return [undefined,a.answer,{ai:true}];}`
  }];
}

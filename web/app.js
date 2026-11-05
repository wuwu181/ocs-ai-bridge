import { installFeatures } from './features.js';
const $ = id => document.getElementById(id);
let features=null;
const names = { overview: '运行概览', models: '接口与模型', routing: '答题策略', test: '在线试答', connect: '连接 OCS', guide: '使用指南',bank:'自建题库',devices:'设备与限额',network:'网络与共享',billing:'费用与统计' };
const modeNames = { auto: '自动', lite: '省 Token', full: '完整多模态' };
const routes = { text: ['文字题', '基础文字题的默认接口。'], vision: ['图片题', '仅选择实际支持视觉输入的模型。'], multiple: ['文字多选题', '留空时使用文字题路由。'], subjective: ['文字主观题', '留空时使用文字题路由。'] };
const presets = {
  ollama:{name:'Ollama 本地模型',protocol:'openai',endpoint:'http://127.0.0.1:11434/v1/chat/completions',model:'',vision:false,authStyle:'none',maxTokens:4096,tokenParameter:'max_tokens'},
  lmstudio:{name:'LM Studio 本地模型',protocol:'openai',endpoint:'http://127.0.0.1:1234/v1/chat/completions',model:'',vision:false,authStyle:'none',maxTokens:4096,tokenParameter:'max_tokens'},
  deepseek: { name: 'DeepSeek Flash', protocol: 'openai', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', vision: true, tokenParameter: 'max_tokens', maxTokens: 4096, temperature: 0.2, jsonMode: true, extraBody: { thinking: { type: 'disabled' } }, liteBody: { thinking: { type: 'disabled' } }, apiKeyEnv: 'DEEPSEEK_API_KEY', authStyle: 'bearer' },
  openai: { name: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: '', vision: true, tokenParameter: 'max_completion_tokens', maxTokens: 4096, apiKeyEnv: 'OPENAI_API_KEY', authStyle: 'bearer' },
  claude: { name: 'Claude', protocol: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: '', vision: true, maxTokens: 4096, anthropicVersion: '2026-10-21', apiKeyEnv: 'ANTHROPIC_API_KEY', authStyle: 'x-api-key' },
  compatible: { name: '兼容接口', protocol: 'openai', endpoint: '', model: '', vision: false, maxTokens: 4096, tokenParameter: 'max_tokens', authStyle: 'bearer' },
  custom_messages: { name: 'Messages 兼容接口', protocol: 'anthropic', endpoint: '', model: '', vision: false, maxTokens: 4096, anthropicVersion: '2023-06-01', authStyle: 'x-api-key' }
};
let token = sessionStorage.getItem('ocs-admin-token') || '';
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.has('token')) { token = hash.get('token'); history.replaceState(null, '', location.pathname); }
let state = { config: null, revision: '', secrets: {}, dirty: false, view: 'overview', exportMode: 'auto', history: [] };
let editing = null, originalProfile = {}, controller = null, toastTimer;

function node(tag, props = {}, children = []) {
  const item = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'text') item.textContent = value;
    else if (key === 'class') item.className = value;
    else if (key.startsWith('on')) item.addEventListener(key.slice(2), value);
    else if (value != null) item.setAttribute(key, value);
  }
  for (const child of children) item.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return item;
}
function badge(text, kind = '') { return node('span', { class: `badge ${kind}`, text }); }
function toast(message) {
  $('toast').textContent = message; $('toast').classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4500);
}
function dirty() { state.dirty = true; $('dirty').classList.remove('hidden'); }
function notice(message) { $('notice').textContent = message; $('notice').classList.toggle('hidden', !message); }
function lock() { token = ''; sessionStorage.removeItem('ocs-admin-token'); $('auth-overlay').classList.remove('hidden'); $('connection-text').textContent = '控制台已锁定'; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) lock();
    throw new Error(result.error?.message || `HTTP ${response.status}`);
  }
  return result;
}
function view(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach(section => section.classList.toggle('hidden', section.id !== `view-${name}`));
  document.querySelectorAll('.nav').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('breadcrumb').textContent = names[name];
  if (name === 'overview') refresh();
  if (name === 'connect') $('export-base').value ||= location.origin;
  features?.show(name).catch(e=>toast(e.message));
}
async function connect() {
  const result = await api('/admin/config');
  state.config = result.config; state.revision = result.revision; state.secrets = {}; state.dirty = false;
  sessionStorage.setItem('ocs-admin-token', token);
  $('auth-overlay').classList.add('hidden'); $('dirty').classList.add('hidden');
  renderModels(); renderSettings(); renderRoutes(); renderProfileOptions();
  await refresh();
}
function displayName(id) { return state.config.profiles[id]?.name || id; }
function renderModels() {
  $('model-grid').replaceChildren(...Object.entries(state.config.profiles).map(([id, profile]) => {
    const ready = profile.hasKey || profile.authStyle === 'none';
    return node('article', { class: 'model-card' }, [
      node('div', { class: 'card-heading' }, [badge(profile.protocol === 'anthropic' ? 'CLAUDE MESSAGES' : 'CHAT COMPLETIONS'), badge(!profile.enabled ? '已停用' : ready ? '已配置' : 'Key 未设置', !profile.enabled ? '' : ready ? 'good' : 'warn')]),
      node('h2', { text: profile.name || id }), node('div', { class: 'model-code', text: profile.model }),
      node('div', { class: 'model-badges' }, [badge(profile.vision ? '文字 + 图片' : '仅文字'), badge(`完整输出 ${profile.maxTokens || 4096}`)]),
      node('p', { class: 'endpoint', text: profile.endpoint }),
      node('div', { class: 'model-actions' }, [
        node('button', { class: 'text-button', text: '编辑接口', onclick: () => openModel(id) }),
        node('button', { class: 'text-button', text: '试答', onclick: () => {
          if (state.dirty) return toast('请先保存配置，再使用已保存的接口试答。');
          view('test'); $('test-profile').value = id;
        } }),
        node('button', { class: 'text-button danger', text: '移除', onclick: () => {
          delete state.config.profiles[id]; delete state.secrets[id];
          Object.keys(routes).forEach(route => state.config.routing[route] = state.config.routing[route].filter(value => value !== id));
          dirty(); renderModels(); renderRoutes(); renderProfileOptions();
        } })
      ])
    ]);
  }));
}
function renderProfileOptions() {
  for (const element of [$('test-profile'), $('export-profile')]) {
    const selected = element.value;
    element.replaceChildren(node('option', { value: '', text: '按答题策略自动选择' }), ...Object.entries(state.config.profiles).map(([id, profile]) => node('option', { value: id, text: (profile.name || id) + (!profile.enabled ? '（停用）' : '') })));
    element.value = Object.hasOwn(state.config.profiles, selected) ? selected : '';
  }
}
function renderSettings() {
  const config = state.config;
  $('setting-mode').value = config.answering.mode;
  $('setting-concurrent').value = config.server.maxConcurrent;
  $('setting-objective').value = config.answering.objectiveTokens;
  $('setting-max').value = config.answering.maxTokens;
  $('setting-attempts').value = config.answering.liteAttempts;
  $('setting-port').value = config.server.port;
  features?.load();
}
for (const [id, parent, field, numeric] of [
  ['setting-mode', 'answering', 'mode', false], ['setting-concurrent', 'server', 'maxConcurrent', true],
  ['setting-objective', 'answering', 'objectiveTokens', true], ['setting-max', 'answering', 'maxTokens', true],
  ['setting-attempts', 'answering', 'liteAttempts', true], ['setting-port', 'server', 'port', true]
]) $(id).addEventListener('change', event => { state.config[parent][field] = numeric ? Number(event.target.value) : event.target.value; dirty(); });
function renderRoutes() {
  $('route-grid').replaceChildren(...Object.entries(routes).map(([name, [title, description]]) => {
    const list = state.config.routing[name] || [];
    const select = node('select', { 'aria-label': title + '备选接口' }, [node('option', { value: '', text: '选择接口...' }), ...Object.entries(state.config.profiles).filter(([id, p]) => !list.includes(id) && (name !== 'vision' || p.vision)).map(([id]) => node('option', { value: id, text: displayName(id) }))]);
    const items = list.map((id, index) => node('div', { class: 'route-item' }, [node('span', { class: 'route-number', text: index + 1 }), node('span', { class: 'route-name', text: displayName(id) }),
      node('button', { class: 'icon-button', text: '↑', 'aria-label': '提前 ' + id, onclick: () => { if (index) { [list[index - 1], list[index]] = [list[index], list[index - 1]]; dirty(); renderRoutes(); } } }),
      node('button', { class: 'icon-button', text: '×', 'aria-label': '移除 ' + id, onclick: () => { list.splice(index, 1); dirty(); renderRoutes(); } })]));
    return node('article', { class: 'card' }, [node('h2', { text: title }), node('p', { class: 'muted', text: description }), node('div', { class: 'route-list' }, items.length ? items : [node('div', { class: 'route-empty', text: name === 'text' || name === 'vision' ? '尚未选择接口' : '使用文字题路由' })]), node('div', { class: 'route-add' }, [select, node('button', { class: 'button small', text: '添加备选', onclick: () => { if (select.value) { list.push(select.value); state.config.routing[name] = list; dirty(); renderRoutes(); } } })])]);
  }));
}

function fillModel(profile) {
  $('model-name').value = profile.name || '';
  $('model-protocol').value = profile.protocol || 'openai';
  $('model-auth').value = profile.authStyle || (profile.protocol === 'anthropic' ? 'x-api-key' : 'bearer');
  $('model-endpoint').value = profile.endpoint || '';
  $('model-model').value = /^YOUR_/.test(profile.model || '') ? '' : profile.model || '';
  $('model-env').value = profile.apiKeyEnv || '';
  $('model-enabled').checked = profile.enabled !== false;
  $('model-vision').checked = !!profile.vision;
  $('model-tokens').value = profile.maxTokens || 4096;
  $('model-token-param').value = profile.tokenParameter || 'max_tokens';
  $('model-version').value = profile.anthropicVersion || '';
  $('model-extra').value = JSON.stringify(profile.extraBody || {}, null, 2);
  $('model-lite-body').value = JSON.stringify(profile.liteBody || {}, null, 2);
  $('model-headers').value = JSON.stringify(profile.extraHeaders || {}, null, 2);
  $('model-json-mode').checked = !!profile.jsonMode;
  $('model-lite-objective').value = profile.liteObjectiveTokens || '';
  $('model-lite-max').value = profile.liteMaxTokens || '';
}
function openModel(id = null) {
  editing = id;
  originalProfile = id ? structuredClone(state.config.profiles[id]) : {};
  $('model-heading').textContent = id ? '编辑接口' : '添加接口';
  $('model-id').value = id || '';
  $('model-id').disabled = !!id;
  $('model-key').value = '';
  $('model-clear-key').checked = false;
  $('model-error').textContent = '';
  $('model-options').replaceChildren();
  $('model-preset').value = id ? (id in presets ? id : originalProfile.protocol === 'anthropic' ? 'custom_messages' : 'compatible') : 'deepseek';
  fillModel(id ? originalProfile : presets.deepseek);
  $('model-dialog').showModal();
}
$('model-preset').addEventListener('change', () => fillModel({ ...presets[$('model-preset').value], enabled: true }));
$('model-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const id = $('model-id').value.trim();
    if (!editing && Object.hasOwn(state.config.profiles, id)) throw new Error('接口标识已经存在，请使用不同名称。');
    const profile = { ...originalProfile, name: $('model-name').value.trim(), protocol: $('model-protocol').value, authStyle: $('model-auth').value, endpoint: $('model-endpoint').value.trim(), model: $('model-model').value.trim(),
      apiKeyEnv: $('model-env').value.trim() || `KEY_${id.replace(/-/g, '_').toUpperCase()}`, enabled: $('model-enabled').checked, vision: $('model-vision').checked,
      maxTokens: Number($('model-tokens').value), tokenParameter: $('model-token-param').value,
      extraBody: JSON.parse($('model-extra').value || '{}'), liteBody: JSON.parse($('model-lite-body').value || '{}'), extraHeaders: JSON.parse($('model-headers').value || '{}'), jsonMode: $('model-json-mode').checked };
    if ($('model-version').value.trim()) profile.anthropicVersion = $('model-version').value.trim();
    for (const [field, id] of [['liteObjectiveTokens', 'model-lite-objective'], ['liteMaxTokens', 'model-lite-max']]) {
      if ($(id).value) profile[field] = Number($(id).value); else delete profile[field];
    }
    const key = $('model-key').value.trim();
    if (key && $('model-clear-key').checked) throw new Error('请在填写新 Key 与清除 Key 中选择一项。');
    if (key) { state.secrets[id] = key; profile.hasKey = true; }
    else if ($('model-clear-key').checked) { state.secrets[id] = null; profile.hasKey = false; }
    state.config.profiles[id] = profile;
    const usableRoute = route => state.config.routing[route].some(name => {
      const p = state.config.profiles[name]; return p?.enabled && (p.hasKey || p.authStyle === 'none');
    });
    if (profile.enabled && (profile.hasKey || profile.authStyle === 'none')) {
      if (!usableRoute('text')) state.config.routing.text = [id];
      if (profile.vision && !usableRoute('vision')) state.config.routing.vision = [id];
    }
    dirty(); renderModels(); renderRoutes(); renderProfileOptions(); $('model-dialog').close(); toast('已应用到工作区，点击顶部“保存配置”后生效。');
  } catch (error) { $('model-error').textContent = error.message; }
});
$('fetch-models').addEventListener('click', async () => {
  if (!editing || state.dirty) { $('model-error').textContent = '请先应用并保存接口，再查询已保存接口的模型列表。'; return; }
  const button = $('fetch-models'); button.disabled = true;
  try {
    const result = await api('/admin/models?profile=' + encodeURIComponent(editing));
    $('model-options').replaceChildren(...result.models.map(id => node('option', { value: id })));
    $('model-error').textContent = `已查询到 ${result.models.length} 个模型，可在模型 ID 输入框选择。`;
  } catch (error) { $('model-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('save').addEventListener('click', async () => {
  if (!state.config) return;
  const button = $('save'); button.disabled = true;
  try {
    const result = await api('/admin/config', { method: 'PUT', body: JSON.stringify({ config: state.config, secrets: state.secrets, expected_revision: state.revision }) });
    state.config = result.config; state.revision = result.revision; state.secrets = {}; state.dirty = false;
    $('dirty').classList.add('hidden'); renderModels(); renderRoutes(); renderSettings(); renderProfileOptions();
    notice(result.restart_required ? '端口或监听地址已修改。请关闭服务窗口后重新运行 start.cmd，并重新导入 OCS 配置。' : '');
    toast('配置已保存，模型和策略已即时更新。'); refresh();
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

function prettyTime(ms) { return ms ? (ms / 1000).toFixed(2) + ' s' : '—'; }
function drawChart(rows) {
  const canvas = $('usage-chart');
  const width = canvas.clientWidth || 600, height = 180, scale = devicePixelRatio || 1;
  canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale); ctx.clearRect(0, 0, width, height);
  const values = rows.slice(0, 30).reverse().map(row => row.usage?.total_tokens || 0);
  $('chart-empty').classList.toggle('hidden', values.some(Boolean));
  ctx.strokeStyle = '#edf1f5'; ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) { const y = i * 42; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  const max = Math.max(...values, 1), step = width / Math.max(values.length, 15), bar = Math.min(step * .55, 24);
  values.forEach((value, i) => { if (!value) return; const h = value / max * 138; ctx.fillStyle = '#76a89c'; ctx.fillRect(i * step + (step - bar) / 2, 164 - h, bar, h); });
}
async function refresh() {
  if (!token || !state.config) return;
  try {
    const data = await api('/admin/state'); state.history = data.history;
    $('connection-text').textContent = data.ready ? '本机服务运行中 · 模型已配置' : '服务运行中 · 请先配置接口 Key';
    $('metric-requests').textContent = data.stats.requests.toLocaleString();
    $('metric-success').textContent = data.stats.requests ? Math.round(data.stats.success / data.stats.requests * 100) + '%' : '—';
    $('metric-errors').textContent = `成功 ${data.stats.success} · 失败 ${data.stats.failed}`;
    $('metric-tokens').textContent = data.stats.total_tokens.toLocaleString();
    $('metric-usage').textContent = `输入 ${data.stats.input_tokens.toLocaleString()} · 输出 ${data.stats.output_tokens.toLocaleString()}`;
    $('metric-cache').textContent = data.stats.cached.toLocaleString();
    $('workspace-models').textContent = `${data.configured_profiles} 个`;
    $('workspace-mode').textContent = modeNames[state.config.answering.mode];
    $('workspace-queue').textContent = `${data.active} / ${data.queued}`;
    $('workspace-latency').textContent = prettyTime(data.stats.average_ms);
    const rows = data.history.map(row => node('tr', {}, [
      node('td', {}, [node('div', { class: 'time', text: new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false,timeZone:'Asia/Shanghai' }) }), node('div', { class: 'question-summary', text: row.question, title: row.question })]),
      node('td', { text: row.profile ? displayName(row.profile) : '—' }), node('td', {}, [badge(modeNames[row.mode] || row.mode || '自动')]),
      node('td', {}, [badge(row.cached ? '缓存' : row.success ? '成功' : row.error_code || '失败', row.success ? 'good' : 'bad')]),
      node('td', { text: prettyTime(row.elapsed_ms) }), node('td', { text: row.usage?.reported ? (row.usage.total_tokens || 0).toLocaleString() : '未上报' })
    ]));
    $('history').replaceChildren(...(rows.length ? rows : [node('tr', {}, [node('td', { colspan: '6', class: 'empty', text: '暂无请求。先配置模型，或去在线试答。' })])]));
    if (state.view === 'overview') drawChart(data.history);
  } catch (error) { $('connection-text').textContent = '连接暂不可用'; }
}
$('refresh').addEventListener('click', refresh);
$('clear-cache').addEventListener('click', async () => { try { await api('/admin/cache/clear', { method: 'POST', body: '{}' }); toast('缓存已清空。'); } catch (error) { toast(error.message); } });

const dataUrl = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
let images = [];
$('test-images').addEventListener('change', async () => {
  try {
    const files = Array.from($('test-images').files);
    if (files.length > state.config.limits.maxImages) throw new Error('选择的图片过多。');
    if (files.some(file => file.size > state.config.limits.maxImageBytes)) throw new Error('有图片超过单张大小上限，请压缩。');
    images = await Promise.all(files.map(async (file, i) => ({ name: file.name, url: await dataUrl(file), index: i + 1 })));
    $('image-list').replaceChildren(...images.map(item => node('div', { class: 'image-item' }, [node('img', { src: item.url, alt: item.name }), node('span', { text: `[图片${item.index}]` })])));
  } catch (error) { images = []; $('test-images').value = ''; $('image-list').replaceChildren(); toast(error.message); }
});
$('clear-images').addEventListener('click', () => { images = []; $('test-images').value = ''; $('image-list').replaceChildren(); });
$('test-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.dirty) return toast('请先保存配置，再测试实际生效的接口。');
  controller = new AbortController();
  $('run-test').disabled = true; $('cancel-test').classList.remove('hidden');
  $('result-status').textContent = '正在试答'; $('test-result').textContent = '正在等待模型返回…'; $('test-meta').replaceChildren();
  try {
    const value = await api('/admin/test', { method: 'POST', signal: controller.signal, body: JSON.stringify({ title: $('test-title').value, type: $('test-type').value, options: $('test-options').value,
      mode: $('test-mode').value, profile: $('test-profile').value, use_database:$('test-database').checked, images: images.map(item => item.url) }) });
    $('test-json').textContent = JSON.stringify(value, null, 2);
    $('result-status').textContent = value.code === 1 ? '已完成' : '请求失败';
    $('test-result').textContent = value.code === 1 ? value.display_answer : value.error?.message || '没有返回答案';
    if (value.code === 1) $('test-meta').replaceChildren(badge(displayName(value.profile), 'good'), badge(modeNames[value.mode]), badge(prettyTime(value.elapsed_ms)), badge(value.usage?.reported ? `${value.usage.total_tokens} Token` : '用量未上报'), ...(value.cached ? [badge('缓存命中', 'good')] : []));
    refresh();
  } catch (error) { $('result-status').textContent = '已停止'; $('test-result').textContent = error.name === 'AbortError' ? '已取消本次试答。' : error.message; }
  finally { $('run-test').disabled = false; $('cancel-test').classList.add('hidden'); controller = null; }
});
$('cancel-test').addEventListener('click', () => controller?.abort());
async function exported() {
  const params = new URLSearchParams({ mode: state.exportMode, base: $('export-base').value || location.origin, profile: $('export-profile').value,device:$('export-device').value });
  return api('/admin/ocs-config?' + params);
}
$('preview-config').addEventListener('click', async () => { try { $('config-preview').textContent = JSON.stringify(await exported(), null, 2); $('config-preview').classList.remove('hidden'); } catch (error) { toast(error.message); } });
$('copy-config').addEventListener('click', async () => {
  try { const value = JSON.stringify(await exported(), null, 2); await navigator.clipboard.writeText(value); toast('已复制，可粘贴到 OCS 题库配置。'); }
  catch (error) { toast('复制未完成，可使用“下载 JSON”后打开复制。' + error.message); }
});
$('download-config').addEventListener('click', async () => {
  try {
    const value = JSON.stringify(await exported(), null, 2);
    const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
    const link = node('a', { href: url, download: `OCS-${state.exportMode}.json` }); document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { toast(error.message); }
});
document.querySelectorAll('[data-export-mode]').forEach(button => button.addEventListener('click', () => {
  state.exportMode = button.dataset.exportMode;
  document.querySelectorAll('[data-export-mode]').forEach(item => item.classList.toggle('selected', item === button));
  $('config-preview').classList.add('hidden');
}));
features=installFeatures({ $,node,api,state:()=>state,dirty,toast,view });
$('model-preset').append(node('option',{value:'ollama',text:'Ollama 本地模型'}),node('option',{value:'lmstudio',text:'LM Studio 本地模型'}));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(button => button.addEventListener('click', () => view(button.dataset.goto)));
$('add-model').addEventListener('click', () => openModel());
$('close-dialog').addEventListener('click', () => $('model-dialog').close());
$('logout').addEventListener('click', lock);
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); token = $('auth-token').value.trim();
  try { await connect(); $('auth-token').value = ''; $('auth-error').textContent = ''; } catch (error) { $('auth-error').textContent = error.message; }
});
window.addEventListener('resize', () => { if (state.view === 'overview') drawChart(state.history); });
setInterval(() => { if (!document.hidden && token) refresh(); }, 7000);
if (token) connect().catch(error => { $('auth-error').textContent = error.message; });

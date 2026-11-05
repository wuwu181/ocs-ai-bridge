import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { projectRoot, validateConfig, loadDotEnv } from './config.mjs';
import { BridgeError } from './providers.mjs';
import { bridgeConfig } from './ocs.mjs';

export function atomicWrite(path, content) {
  const temporary = path + '.tmp-' + randomBytes(4).toString('hex');
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}
function environment(root, base) {
  const local = {};
  loadDotEnv(resolve(root, '.env'), local);
  return { ...base, ...local };
}
function revision(raw) { return createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 20); }
function envLine(source, name, value) {
  const regex = new RegExp(`^${name}=.*$`, 'm');
  const line = `${name}=${value}`;
  return regex.test(source) ? source.replace(regex, () => line) : source.trimEnd() + '\n' + line + '\n';
}

export function initializeFiles(root = projectRoot, env = process.env) {
  const configPath = resolve(root, 'config.json');
  const envPath = resolve(root, '.env');
  if (!existsSync(configPath)) atomicWrite(configPath, readFileSync(resolve(root, 'config.example.json'), 'utf8'));
  const raw = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const currentEnv = environment(root, env);
  const tokenName = raw.server?.tokenEnv || 'OCS_BRIDGE_TOKEN';
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(tokenName)) throw new Error('无效 tokenEnv 配置。');
  let token = currentEnv[tokenName];
  if (!token || token.length < 24 || /^(REPLACE_|YOUR_)/.test(token)) {
    token = randomBytes(32).toString('hex');
    const source = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '# Local secrets. Do not share.\n';
    atomicWrite(envPath, envLine(source, tokenName, token));
  }
  return new ConfigStore(root, env);
}

export class ConfigStore {
  constructor(root = projectRoot, env = process.env) {
    this.root = root;
    this.envBase = { ...env };
    this.raw = JSON.parse(readFileSync(resolve(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    this.config = validateConfig(this.raw, environment(root, this.envBase));
    this.revision = revision(this.raw);
  }
  publicConfig() {
    const profiles = {};
    for (const [id, raw] of Object.entries(this.raw.profiles)) {
      const { apiKey, api_key, key, token, ...safe } = raw;
      profiles[id] = { ...safe, hasKey: !!this.config.profiles[id]?.apiKey || raw.authStyle === 'none' };
    }
    return structuredClone({ revision: this.revision, config: { server: this.config.server, limits: this.config.limits, answering: this.config.answering, routing: this.config.routing, profiles } });
  }
  save(payload) {
    if (payload.expected_revision && payload.expected_revision !== this.revision) throw new BridgeError('config_conflict', '配置已被其他页面修改，请刷新后重新编辑。', 409);
    if (!payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)) throw new BridgeError('invalid_config', '缺少完整配置。', 400);
    const raw = structuredClone(payload.config);
    for (const profile of Object.values(raw.profiles || {})) for (const field of ['hasKey', 'apiKey', 'api_key', 'key', 'token']) delete profile[field];
    if (raw.server?.tokenEnv !== this.config.server.tokenEnv) throw new BridgeError('token_change', '管理页不能修改 tokenEnv，请在本地配置文件中修改并重新启动。', 400);
    let source = existsSync(resolve(this.root, '.env')) ? readFileSync(resolve(this.root, '.env'), 'utf8') : '';
    const changed = new Map();
    for (const [id, value] of Object.entries(payload.secrets || {})) {
      const profile = raw.profiles?.[id];
      if (!profile) throw new BridgeError('unknown_profile', 'Key 对应的接口不存在。', 400);
      const name = profile.apiKeyEnv;
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(name || '')) throw new BridgeError('invalid_env', 'API Key 环境变量名无效。', 400);
      if (value === '') continue;
      if (value !== null && (typeof value !== 'string' || /[\s\r\n]/.test(value) || value.length > 4096)) throw new BridgeError('invalid_key', 'API Key 格式无效。', 400);
      const key = value === null ? '' : value;
      if (changed.has(name) && changed.get(name) !== key) throw new BridgeError('key_conflict', '同一环境变量不能保存两把不同 Key。', 400);
      changed.set(name, key);
      source = envLine(source, name, key);
    }
    const nextEnv = { ...this.envBase };
    const local = {};
    const temp = source.split(/\r?\n/);
    for (const line of temp) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
      if (match) local[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
    Object.assign(nextEnv, local);
    let next;
    try { next = validateConfig(raw, nextEnv); }
    catch (error) { throw new BridgeError('invalid_config', error.message, 400); }
    const backup = resolve(this.root, 'backups', `${Date.now()}-${randomBytes(3).toString('hex')}`);
    mkdirSync(backup, { recursive: true });
    for (const name of ['config.json', '.env']) if (existsSync(resolve(this.root, name))) copyFileSync(resolve(this.root, name), resolve(backup, name));
    const previousEnv = existsSync(resolve(this.root, '.env')) ? readFileSync(resolve(this.root, '.env'), 'utf8') : '';
    try {
      atomicWrite(resolve(this.root, '.env'), source);
      atomicWrite(resolve(this.root, 'config.json'), JSON.stringify(raw, null, 2) + '\n');
    } catch (error) {
      atomicWrite(resolve(this.root, '.env'), previousEnv);
      throw error;
    }
    const restartRequired = next.server.host !== this.config.server.host || next.server.port !== this.config.server.port;
    this.raw = raw;
    this.config = next;
    this.revision = revision(raw);
    return { ...this.publicConfig(), restart_required: restartRequired };
  }
  exportFiles(base = `http://127.0.0.1:${this.config.server.port}`) {
    for (const mode of ['auto', 'lite', 'full']) atomicWrite(resolve(this.root, `ocs-${mode}.json`), JSON.stringify(bridgeConfig(this.config.token, base, '', mode), null, 2) + '\n');
    atomicWrite(resolve(this.root, 'ocs-local.json'), JSON.stringify(bridgeConfig(this.config.token, base), null, 2) + '\n');
  }
}

import { createInterface } from 'node:readline/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { projectRoot, loadDotEnv, validateConfig } from './lib/config.mjs';
import { bridgeConfig } from './lib/ocs.mjs';

let muted = false;
const output = new Writable({ write(chunk, encoding, callback) {
  if (muted) callback();
  else process.stdout.write(chunk, encoding, callback);
} });
const rl = createInterface({ input: process.stdin, output, terminal: !!(process.stdin.isTTY && process.stdout.isTTY) });
async function ask(label, defaultValue = '') {
  const answer = (await rl.question(`${label}${defaultValue ? ` [${defaultValue}]` : ''}: `)).trim();
  return answer || defaultValue;
}
async function secret(label) {
  process.stdout.write(`${label} (hidden): `);
  muted = true;
  try {
    return (await rl.question('')).trim();
  } finally { muted = false; process.stdout.write('\n'); }
}
function setEnvLine(source, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(source) ? source.replace(pattern, () => line) : source.replace(/\s*$/, '') + '\n' + line + '\n';
}
try {
  console.log('OCS multimodal AI setup (Node.js 22+, no npm install required).');
  console.log('1 DeepSeek  2 OpenAI  3 Claude  4 Custom Chat Completions  5 Custom Messages');
  const choice = await ask('Provider', '1');
  if (!['1', '2', '3', '4', '5'].includes(choice)) throw new Error('Choose 1, 2, 3, 4 or 5.');
  const configPath = resolve(projectRoot, 'config.json');
  const config = JSON.parse(readFileSync(existsSync(configPath) ? configPath : resolve(projectRoot, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
  const id = { 1: 'deepseek', 2: 'openai', 3: 'claude', 4: 'compatible', 5: 'custom_messages' }[choice];
  if (!config.profiles[id]) config.profiles[id] = { ...config.profiles.claude, apiKeyEnv: 'COMPATIBLE_API_KEY', anthropicVersion: '2023-06-01' };
  const profile = config.profiles[id];
  if (choice === '4' || choice === '5') {
    profile.endpoint = await ask('Full API endpoint (include /chat/completions or /messages)');
    profile.vision = (await ask('Does this model accept images? y/n', 'n')).toLowerCase() === 'y';
    profile.protocol = choice === '5' ? 'anthropic' : 'openai';
    if (choice === '5') profile.anthropicVersion = await ask('anthropic-version header', profile.anthropicVersion || '2023-06-01');
  }
  const defaultModel = /^YOUR_/.test(profile.model) ? '' : profile.model;
  profile.model = await ask('Exact model ID from your provider', defaultModel);
  if (!profile.model || /^YOUR_/.test(profile.model)) throw new Error('A valid model ID is required.');
  const key = await secret('API key');
  if (!key || /[\s\r\n]/.test(key) || /^(?:REPLACE_|YOUR_)/.test(key)) throw new Error('Enter a valid API key without spaces.');
  profile.enabled = true;
  config.routing.text = [id];
  config.routing.vision = profile.vision ? [id] : [];
  config.routing.multiple = [];
  config.routing.subjective = [];
  const envPath = resolve(projectRoot, '.env');
  const env = {};
  loadDotEnv(envPath, env);
  let token = env[config.server.tokenEnv];
  if (!token || token.length < 24 || /^(?:REPLACE_|YOUR_)/.test(token)) token = randomBytes(32).toString('hex');
  let envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '# Local secrets. Do not share this file.\n';
  envText = setEnvLine(envText, config.server.tokenEnv, token);
  envText = setEnvLine(envText, profile.apiKeyEnv, key);
  env[config.server.tokenEnv] = token;
  env[profile.apiKeyEnv] = key;
  validateConfig(config, env);
  writeFileSync(envPath, envText, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const base = `http://127.0.0.1:${config.server.port}`;
  writeFileSync(resolve(projectRoot, 'ocs-local.json'), JSON.stringify(bridgeConfig(token, base), null, 2) + '\n', { mode: 0o600 });
  console.log('Saved config.json, .env and ocs-local.json. No API calls were made.');
  console.log('Next: node server.mjs -> import ocs-local.json in OCS -> enable image optimization.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { rl.close(); }

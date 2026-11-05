import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readConfig, projectRoot } from './lib/config.mjs';
import { bridgeConfig } from './lib/ocs.mjs';

try {
  const config = readConfig();
  const base = process.argv[2] || `http://127.0.0.1:${config.server.port}`;
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('请填写接口服务根地址，例如 https://ai.example.com，不要带路径。');
  writeFileSync(resolve(projectRoot, 'ocs-local.json'), JSON.stringify(bridgeConfig(config.token, url.origin), null, 2) + '\n', { mode: 0o600 });
  console.log('Updated ocs-local.json. Re-import it into OCS.');
} catch (error) { console.error(error.message); process.exitCode = 1; }

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { projectRoot } from './lib/config.mjs';
import { initializeFiles, ConfigStore } from './lib/store.mjs';
import { createBridgeServer, VERSION } from './server.mjs';
import { redact } from './lib/providers.mjs';

function openBrowser(url) {
  const command = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] :
    process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: false, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log('无法自动打开浏览器，请访问控制台地址并输入 .env 中的本机 token。'));
  child.unref();
}
async function running(port, token, expectedId) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
    const value = await response.json();
    if (!response.ok || value.service !== 'ocs-ai-bridge' || !value.ui || value.instance_id !== expectedId) return false;
    const check = await fetch(`http://127.0.0.1:${port}/admin/config`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1200) });
    return check.ok;
  } catch { return false; }
}
async function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const error = value => { server.off('listening', ready); reject(value); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready); server.listen(port, host);
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更高版本。');
  if (args.includes('--check')) {
    console.log(`Node.js ${process.versions.node}`);
    if (!existsSync(resolve(projectRoot, 'config.json'))) { console.log('尚未初始化。双击 start.cmd 可自动创建本机配置。'); return; }
    const store = new ConfigStore();
    console.log(`配置可读取；本机端口 ${store.config.server.port}；模型配置 ${Object.keys(store.config.profiles).length} 个。`);
    console.log('未调用模型。API Key 与本机 token 不会显示在诊断输出中。');
    return;
  }
  const store = initializeFiles();
  const explicitPort = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : null;
  if (explicitPort !== null && (!Number.isInteger(explicitPort) || explicitPort < 1024 || explicitPort > 65535)) throw new Error('--port 必须为 1024 至 65535 的整数。');
  const initialPort = explicitPort || store.config.server.port;
  const instanceId = createHash('sha256').update(store.config.token + store.root).digest('hex').slice(0, 16);
  if (await running(initialPort, store.config.token, instanceId)) {
    console.log(`已检测到本目录的运行实例：http://127.0.0.1:${initialPort}/`);
    if (!args.includes('--no-browser')) openBrowser(`http://127.0.0.1:${initialPort}/#token=${encodeURIComponent(store.config.token)}`);
    return;
  }
  let bridge, selectedPort;
  for (let offset = 0; offset < 10 && initialPort + offset <= 65535; offset++) {
    selectedPort = initialPort + offset;
    const config = { ...store.config, server: { ...store.config.server, port: selectedPort } };
    bridge = createBridgeServer(config, { store, log: value => console.log(JSON.stringify(value)) });
    try { await listen(bridge.server, selectedPort, config.server.host); break; }
    catch (error) {
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
      bridge = null;
      console.log(`端口 ${selectedPort} 已占用或不可使用，尝试下一个端口。`);
    }
  }
  if (!bridge) throw new Error('未找到空闲端口，请运行 node launcher.mjs --port 其他端口。');
  if (selectedPort !== store.config.server.port) {
    const publicValue = store.publicConfig();
    publicValue.config.server.port = selectedPort;
    store.save({ config: publicValue.config, expected_revision: publicValue.revision });
    console.log(`当前使用 ${selectedPort}，本地配置已更新。请重新导入生成的 OCS 配置。`);
  }
  store.exportFiles(`http://127.0.0.1:${selectedPort}`);
  mkdirSync(resolve(projectRoot, 'run'), { recursive: true });
  writeFileSync(resolve(projectRoot, 'run/server.json'), JSON.stringify({ pid: process.pid, port: selectedPort, version: VERSION, started: new Date().toISOString() }, null, 2));
  console.log(`\nOCS AI 控制台 v${VERSION}\nhttp://127.0.0.1:${selectedPort}/\n`);
  console.log('已生成 ocs-auto.json / ocs-lite.json / ocs-full.json。');
  console.log('模型设置可在网页中完成；保存后即时生效。保持本窗口运行，按 Ctrl+C 停止。');
  if (!args.includes('--no-browser')) openBrowser(`http://127.0.0.1:${selectedPort}/#token=${encodeURIComponent(store.config.token)}`);
  const close = () => {
    console.log('\n正在停止本机服务…');
    bridge.server.close(() => process.exit(0));
    setTimeout(() => { bridge.server.closeAllConnections(); process.exit(0); }, 2500).unref();
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });

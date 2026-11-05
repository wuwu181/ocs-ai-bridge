import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from './lib/config.mjs';
import { directConfig, bridgeConfig } from './lib/ocs.mjs';

const example = JSON.parse(readFileSync(resolve(projectRoot, 'config.example.json'), 'utf8'));
const target = resolve(projectRoot, 'configs');
mkdirSync(target, { recursive: true });
const files = [
  ['deepseek-direct.json', directConfig(example.profiles.deepseek, 'DeepSeek 多模态全题型', 'REPLACE_WITH_DEEPSEEK_API_KEY')],
  ['openai-direct.json', directConfig(example.profiles.openai, 'OpenAI Chat Completions 多模态', 'REPLACE_WITH_OPENAI_API_KEY')],
  ['anthropic-direct.json', directConfig(example.profiles.claude, 'Anthropic Messages 多模态', 'REPLACE_WITH_ANTHROPIC_API_KEY')],
  ['ollama-direct.json', directConfig({protocol:'openai',endpoint:'http://127.0.0.1:11434/v1/chat/completions',model:'YOUR_LOCAL_MODEL',authStyle:'none',maxTokens:4096}, 'Ollama 本地模型直连', '')],
  ['ocs-local.example.json', bridgeConfig('REPLACE_WITH_BRIDGE_TOKEN_GENERATED_BY_SETUP')],
  ['ocs-lite.example.json', bridgeConfig('REPLACE_WITH_BRIDGE_TOKEN_GENERATED_BY_SETUP', 'http://127.0.0.1:8765', '', 'lite')],
  ['ocs-full.example.json', bridgeConfig('REPLACE_WITH_BRIDGE_TOKEN_GENERATED_BY_SETUP', 'http://127.0.0.1:8765', '', 'full')]
];
for (const [filename, config] of files) writeFileSync(resolve(target, filename), JSON.stringify(config, null, 2) + '\n');
console.log(`Generated ${files.length} importable OCS templates in configs/.`);

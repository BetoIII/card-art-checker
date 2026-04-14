/**
 * One-time setup script — creates the Claude Managed Agent and Environment.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/setup-agent.js
 *
 * Outputs the AGENT_ID, ENV_ID, and SPEC_SCRIPT_FILE_ID to add to Vercel env vars.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});

async function main() {
  console.log('Setting up Card Art Checker agent...\n');

  // 1. Read agent system prompt
  const systemPrompt = readFileSync(
    resolve(__dirname, '../prompts/agent-system-prompt.md'),
    'utf-8'
  );

  // 2. Create agent
  console.log('Creating agent...');
  const agent = await anthropic.beta.agents.create({
    name: 'card-art-checker',
    description: 'Analyzes virtual card art for compliance with Visa Digital Card Brand Standards and Rain internal requirements',
    model: 'claude-sonnet-4-6',
    system: systemPrompt,
    tools: [
      { type: 'agent_toolset_20260401' },
    ],
  });
  console.log(`  AGENT_ID=${agent.id}`);

  // 3. Create environment with Python packages
  console.log('Creating environment...');
  const environment = await anthropic.beta.environments.create({
    name: 'card-art-env',
    config: {
      type: 'cloud',
      packages: {
        pip: ['Pillow', 'reportlab'],
      },
      networking: { type: 'limited', allowed_hosts: [], allow_package_managers: true },
    },
  });
  console.log(`  ENV_ID=${environment.id}`);

  // 4. Upload spec checker script (reusable across sessions)
  console.log('Uploading spec checker script...');
  const scriptPath = resolve(__dirname, 'check_technical_specs.py');
  let scriptFileId;
  try {
    const scriptContent = readFileSync(scriptPath);
    const scriptFile = new File([scriptContent], 'check_technical_specs.py', { type: 'text/x-python' });
    const uploaded = await anthropic.beta.files.upload({ file: scriptFile });
    scriptFileId = uploaded.id;
    console.log(`  SPEC_SCRIPT_FILE_ID=${scriptFileId}`);
  } catch (err) {
    console.log(`  WARNING: Could not upload spec checker script: ${err.message}`);
    console.log('  You can upload it later and set SPEC_SCRIPT_FILE_ID manually.');
    scriptFileId = '(upload check_technical_specs.py and set this)';
  }

  // 5. Summary
  console.log('\n══════════════════════════════════════════');
  console.log('Setup complete! Add these to Vercel env vars:\n');
  console.log(`  vercel env add AGENT_ID        # ${agent.id}`);
  console.log(`  vercel env add ENV_ID           # ${environment.id}`);
  console.log(`  vercel env add SPEC_SCRIPT_FILE_ID  # ${scriptFileId}`);
  console.log('\n══════════════════════════════════════════');
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});

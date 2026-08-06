/**
 * Setup script — creates (or updates) the Claude Managed Agent and Environment.
 *
 * Usage:
 *   # One-time creation (outputs AGENT_ID, ENV_ID for Vercel env vars):
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/setup-agent.js
 *
 *   # Push prompts/agent-system-prompt.md to the LIVE agent (run after every
 *   # prompt edit — the live agent is otherwise stale; repeat per environment
 *   # if AGENT_ID differs between the two card-art-env deployments):
 *   ANTHROPIC_API_KEY=... AGENT_ID=agent_... node scripts/setup-agent.js --update
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

async function updateAgent() {
  const agentId = process.env.AGENT_ID;
  if (!agentId) {
    throw new Error('AGENT_ID env var is required for --update (pull it with: vercel env pull)');
  }
  const systemPrompt = readFileSync(
    resolve(__dirname, '../prompts/agent-system-prompt.md'),
    'utf-8'
  );
  console.log(`Updating agent ${agentId} system prompt from prompts/agent-system-prompt.md...`);
  // Omitted fields (model, tools, name) are preserved; only the system
  // prompt is replaced. Each update creates a new agent version — running
  // sessions keep their pinned version, new sessions pick up the latest.
  const agent = await anthropic.beta.agents.update(agentId, { system: systemPrompt });
  console.log(`Updated. Agent is now at version ${agent.version}.`);
}

async function main() {
  if (process.argv.includes('--update')) {
    return updateAgent();
  }
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
    // effort=high (not the xhigh default): xhigh visual-inspection turns ran
    // 170-200s, starving the annotated-PDF step of its 90s minimum before the
    // 300s function kill. See lib/pipeline.js RESULTS_PDF_MIN_MS.
    model: { id: 'claude-opus-4-8', effort: { type: 'high' } },
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
        pip: ['Pillow', 'reportlab', 'numpy'],
        // Ghostscript renders .ai/.eps physical card art; pre-installing it
        // here (cached across sessions) saves 1-2 minutes per physical run
        // vs. the agent apt-get installing it inside the sandbox.
        apt: ['ghostscript'],
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

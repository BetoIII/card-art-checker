// Dry-run the slack-identifier sub-agent against real Rocketlane + Slack data.
// Read-only: never posts to Slack, never writes to the run log.
//
//   node --env-file=.env.local scripts/slack-identify-dry-run.js <projectId>
//   node --env-file=.env.local scripts/slack-identify-dry-run.js <projectId> --channels-only
//
// --channels-only skips the LLM and just prints the Rocketlane-bot-created
// channel list (validates ROCKETLANE_SLACK_BOT_ID, token scopes, result size).

import { WebClient } from '@slack/web-api';
import { getProject } from '../lib/rocketlane.js';
import { identifySlackChannel } from '../lib/slack-identify.js';

const args = process.argv.slice(2);
const projectId = args.find((a) => !a.startsWith('--'));
const channelsOnly = args.includes('--channels-only');

if (!projectId && !channelsOnly) {
  console.error('Usage: node scripts/slack-identify-dry-run.js <projectId> [--channels-only]');
  process.exit(1);
}

const BOT_ID = process.env.ROCKETLANE_SLACK_BOT_ID || 'U07DS8F9STS';

async function listBotChannels() {
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  let types = 'public_channel,private_channel';
  const channels = [];
  let cursor;
  let pages = 0;
  while (true) {
    let result;
    try {
      result = await slack.conversations.list({
        types,
        exclude_archived: false,
        limit: 200,
        cursor,
      });
    } catch (err) {
      // Same fallback as lib/slack-identify.js: no groups:read → public only.
      if (err.data?.error === 'missing_scope' && types.includes('private_channel')) {
        console.warn(`(bot lacks ${err.data.needed ?? 'groups:read'} — listing public channels only)\n`);
        types = 'public_channel';
        cursor = undefined;
        channels.length = 0;
        pages = 0;
        continue;
      }
      throw err;
    }
    pages++;
    channels.push(...(result.channels ?? []));
    cursor = result.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  const mine = channels.filter((c) => c.creator === BOT_ID);
  console.log(`Paginated ${pages} page(s), ${channels.length} channels total; ${mine.length} created by ${BOT_ID}:\n`);
  for (const c of mine.sort((a, b) => b.created - a.created)) {
    const created = new Date(c.created * 1000).toISOString().slice(0, 16);
    console.log(`  ${created}  #${c.name}  (${c.id}${c.is_private ? ', private' : ''}${c.is_archived ? ', archived' : ''})`);
  }
}

async function main() {
  if (channelsOnly) {
    await listBotChannels();
    return;
  }

  const project = await getProject(projectId);
  console.log('Project:', JSON.stringify(project, null, 2));

  const fakeRunLog = { event: (...a) => console.log('[event]', ...a) };
  const result = await identifySlackChannel({
    projectId,
    projectName: project.projectName,
    runLog: fakeRunLog,
  });
  console.log('\nResult:', JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

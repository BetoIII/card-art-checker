import Anthropic from '@anthropic-ai/sdk';
import { getSlack } from './slack-client.js';
import { getProject } from './rocketlane.js';

// Slack-identifier sub-agent: a Claude tool-use loop that resolves which
// customer Slack channel belongs to a Rocketlane project. The Rocketlane
// Slack bot auto-creates an ext-{name}-rain channel shortly after each
// project is created, so the primary signal is creation-time proximity
// (channel `created` vs project `createdAt`), with the name pattern as a
// secondary signal — names can be edited later, creation times can't.
//
// identifySlackChannel never rejects; on any failure it resolves with
// confidence 'none' so callers can start it eagerly (concurrent with the
// multi-minute card-art analysis) and await it at delivery time.

// ── Lazy Anthropic client ───────────────────────────────────────────
// Separate from lib/pipeline.js's client: that one carries the managed-agents
// beta header, which doesn't apply to plain messages calls.

let _anthropic;
function getAnthropic() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

const MODEL = () => process.env.SLACK_IDENTIFY_MODEL || 'claude-sonnet-4-6';
const ROCKETLANE_BOT_ID = () => process.env.ROCKETLANE_SLACK_BOT_ID || 'U07DS8F9STS';
const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You identify the Slack channel for a Rocketlane customer project.

When a project is created in Rocketlane, its Slack integration bot automatically creates a channel shortly afterward — typically within minutes, occasionally up to ~48 hours. Every channel returned by list_rocketlane_channels was created by that bot, so each result is a genuine Rocketlane project channel; your job is to pick which one belongs to THIS project.

Signals, strongest first:
1. Creation-time proximity — the channel's created time falls shortly AFTER the project's createdAt. Start with a window of [project createdAt − 1 hour, createdAt + 48 hours]; widen stepwise (up to ~14 days after) only if the window is empty.
2. Name pattern — channels are named ext-{projectname-ish}-rain where the middle is a lowercased, squashed version of the project name. Channels can be renamed later, so a name mismatch does not rule out a time match — but a name match on a channel created months away from the project is suspect.

Confidence rules:
- high: time and name both point at the same channel; OR exactly one channel in the time window and its name is plausible for this customer.
- low: several window candidates and the name doesn't clearly disambiguate; or the only match is name-only with no time support; or the sole time-window candidate has a name that clearly belongs to a different customer.
- none: no candidates, or nothing plausible.
- An archived channel can never be high — report it as a candidate with low or none and note that it is archived.

Posting a client report to the wrong client's channel is the worst possible outcome — when in doubt, report lower confidence.

Call get_project first, then list_rocketlane_channels with a window, then report_channel exactly once with your conclusion, every candidate you considered, and one-or-two-sentence reasoning. Be economical — usually 3 tool calls total suffice.`;

const TOOLS = [
  {
    name: 'get_project',
    description: 'Fetch the Rocketlane project: name and creation timestamp (epoch milliseconds plus ISO string). Call this first to anchor the time-window search.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_rocketlane_channels',
    description: 'List Slack channels created by the Rocketlane integration bot, optionally restricted to a creation-time window (epoch seconds, inclusive). Returns {id, name, created (epoch seconds), created_iso, is_archived, is_private} per channel.',
    input_schema: {
      type: 'object',
      properties: {
        created_after: { type: 'number', description: 'Epoch seconds, inclusive lower bound on channel created time' },
        created_before: { type: 'number', description: 'Epoch seconds, inclusive upper bound on channel created time' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'report_channel',
    description: 'Report your final answer. Call exactly once when you have concluded.',
    input_schema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack channel ID of the identified channel (omit when confidence is none)' },
        channelName: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'low', 'none'] },
        reasoning: { type: 'string', description: 'One or two sentences explaining the conclusion' },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              created: { type: 'number' },
              is_archived: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['confidence', 'reasoning'],
      additionalProperties: false,
    },
  },
];

// Paginate conversations.list once per identify run and filter to channels the
// Rocketlane bot created; window queries re-filter this cache instead of
// re-paginating (Tier 2 rate limits make full pagination the expensive part —
// WebClient auto-retries 429s honoring Retry-After).
async function fetchRocketlaneChannels() {
  const slack = getSlack();
  const botId = ROCKETLANE_BOT_ID();
  let types = 'public_channel,private_channel';
  const channels = [];
  let cursor;
  let privateScopeMissing = false;

  do {
    let result;
    try {
      result = await slack.conversations.list({
        types,
        exclude_archived: false,
        limit: 200,
        cursor,
      });
    } catch (err) {
      // Bot lacks groups:read → retry public-only from the start.
      if (err.data?.error === 'missing_scope' && types.includes('private_channel')) {
        types = 'public_channel';
        privateScopeMissing = true;
        cursor = undefined;
        channels.length = 0;
        continue;
      }
      throw err;
    }
    channels.push(...(result.channels ?? []));
    cursor = result.response_metadata?.next_cursor;
  } while (cursor);

  return {
    privateScopeMissing,
    channels: channels
      .filter((c) => c.creator === botId)
      .map((c) => ({
        id: c.id,
        name: c.name,
        created: c.created,
        created_iso: new Date(c.created * 1000).toISOString(),
        is_archived: !!c.is_archived,
        is_private: !!c.is_private,
      })),
  };
}

export async function identifySlackChannel({ projectId, projectName, runLog }) {
  const event = (message, status = 'running') => {
    try {
      runLog?.event('slack-identify', message, status);
    } catch {
      // run log must never break identification
    }
  };

  try {
    if (!getSlack()) {
      return { confidence: 'none', reasoning: 'Slack is not configured (no SLACK_BOT_TOKEN)', candidates: [] };
    }

    event(`identifying customer channel for project ${projectId}…`);

    // Ground truth cache: fetched on first list_rocketlane_channels call,
    // reused for later window queries and for validating the final answer.
    let channelCache = null;
    const getChannelCache = async () => {
      if (!channelCache) channelCache = await fetchRocketlaneChannels();
      return channelCache;
    };

    const runTool = async (toolUse) => {
      const base = { type: 'tool_result', tool_use_id: toolUse.id };
      try {
        if (toolUse.name === 'get_project') {
          const project = await getProject(projectId);
          event(`get_project → "${project.projectName}" created ${project.createdAtIso ?? project.createdAt}`);
          return { ...base, content: JSON.stringify(project) };
        }
        if (toolUse.name === 'list_rocketlane_channels') {
          const { channels, privateScopeMissing } = await getChannelCache();
          const { created_after, created_before } = toolUse.input ?? {};
          const windowed = channels.filter((c) =>
            (created_after == null || c.created >= created_after) &&
            (created_before == null || c.created <= created_before)
          );
          event(`list_rocketlane_channels window=[${created_after ?? '-'}, ${created_before ?? '-'}] → ${windowed.length} candidate(s) of ${channels.length} bot-created channels`);
          return {
            ...base,
            content: JSON.stringify({
              channels: windowed,
              ...(privateScopeMissing
                ? { note: 'Private channels are not visible (bot lacks groups:read scope) — only public channels are listed.' }
                : {}),
            }),
          };
        }
        return { ...base, content: `Unknown tool: ${toolUse.name}`, is_error: true };
      } catch (err) {
        return { ...base, content: `Tool failed: ${String(err?.message || err)}`, is_error: true };
      }
    };

    // Validate the model's answer against ground truth: the reported channel
    // must exist in the creator-filtered cache (hallucination guard), and
    // is_archived comes from Slack's data, never the model's claim.
    const finalize = async (input) => {
      const result = {
        channelId: input.channelId,
        channelName: input.channelName,
        confidence: input.confidence ?? 'none',
        reasoning: input.reasoning ?? '',
        candidates: Array.isArray(input.candidates) ? input.candidates : [],
        isArchived: false,
      };
      if (result.channelId) {
        const { channels } = await getChannelCache();
        const match = channels.find((c) => c.id === result.channelId);
        if (!match) {
          result.confidence = result.confidence === 'high' ? 'low' : result.confidence;
          result.reasoning += ' [downgraded: reported channel id not found among Rocketlane-bot-created channels]';
        } else {
          result.channelName = match.name;
          result.isArchived = match.is_archived;
        }
      }
      const label = result.channelId ? `#${result.channelName} (${result.channelId})` : result.reasoning;
      event(`confidence=${result.confidence} → ${label}`, result.confidence === 'high' ? 'done' : 'error');
      return result;
    };

    const messages = [{
      role: 'user',
      content: `Identify the Slack channel for Rocketlane project ${projectId}${projectName ? ` ("${projectName}")` : ''}.`,
    }];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await getAnthropic().messages.create({
        model: MODEL(),
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        // Last chance: force the final answer instead of looping forever.
        ...(i === MAX_ITERATIONS - 1 ? { tool_choice: { type: 'tool', name: 'report_channel' } } : {}),
      });

      const report = response.content.find((b) => b.type === 'tool_use' && b.name === 'report_channel');
      if (report) return await finalize(report.input);

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        // Model answered in prose — one forced report call, then give up.
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: 'Call report_channel now with your conclusion.' });
        const forced = await getAnthropic().messages.create({
          model: MODEL(),
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
          tool_choice: { type: 'tool', name: 'report_channel' },
        });
        const forcedReport = forced.content.find((b) => b.type === 'tool_use' && b.name === 'report_channel');
        if (forcedReport) return await finalize(forcedReport.input);
        break;
      }

      messages.push({ role: 'assistant', content: response.content });
      // All tool_results for this turn go back in ONE user message.
      messages.push({ role: 'user', content: await Promise.all(toolUses.map(runTool)) });
    }

    event('identifier did not reach a conclusion', 'error');
    return { confidence: 'none', reasoning: 'Identifier did not reach a conclusion within the iteration limit', candidates: [] };
  } catch (err) {
    console.error(`[slack-identify] failed for project ${projectId}:`, err);
    event(`failed: ${String(err?.message || err)}`, 'error');
    return { confidence: 'none', reasoning: 'Identifier errored', error: String(err?.message || err), candidates: [] };
  }
}

import { WebClient } from '@slack/web-api';

// Lazy shared Slack client. Null when SLACK_BOT_TOKEN isn't provisioned —
// callers treat that as "Slack disabled" and skip gracefully. WebClient
// auto-retries HTTP 429s honoring Retry-After, so no custom backoff here.

let _slack;
export function getSlack() {
  if (_slack === undefined) {
    _slack = process.env.SLACK_BOT_TOKEN
      ? new WebClient(process.env.SLACK_BOT_TOKEN)
      : null;
  }
  return _slack;
}

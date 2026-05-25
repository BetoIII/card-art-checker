export function GET() {
  return Response.json({
    ok: true,
    time: Date.now(),
    env: {
      SLACK_BOT_TOKEN: !!process.env.SLACK_BOT_TOKEN,
      SLACK_BOT_TOKEN_len: (process.env.SLACK_BOT_TOKEN || '').length,
      SLACK_BOT_TOKEN_prefix: (process.env.SLACK_BOT_TOKEN || '').slice(0, 4),
      ROCKETLANE_API_KEY: !!process.env.ROCKETLANE_API_KEY,
      ROCKETLANE_WEBHOOK_SECRET: !!process.env.ROCKETLANE_WEBHOOK_SECRET,
      ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
      AGENT_ID: !!process.env.AGENT_ID,
      ENV_ID: !!process.env.ENV_ID,
      SPEC_SCRIPT_FILE_ID: !!process.env.SPEC_SCRIPT_FILE_ID,
      BLOB_READ_WRITE_TOKEN: !!process.env.BLOB_READ_WRITE_TOKEN,
    },
  });
}

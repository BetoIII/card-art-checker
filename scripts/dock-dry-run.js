// Dry-run of the Dock → card-art-checker pipeline, WITHOUT delivery.
//
// Simulates a `workspace.form.submitted` Dock webhook by replaying a real
// payload, extracts the card-art file_upload answer (signed GCS URL),
// downloads it, runs the analysis pipeline, and writes the PDF report to disk.
// Slack / Rocketlane delivery is intentionally skipped — this only proves a
// report can be generated end-to-end from a Dock webhook payload.
//
// Run:  node --env-file=.env.local scripts/dock-dry-run.js
//
// The embedded payload's signed URLs expire ~1h after the original webhook;
// pass a fresh card-art URL as argv[2] to re-run after they lapse.

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { runAnalysis } from '../lib/pipeline.js';
import { extractCardArtFile, cardTypeFromForm } from '../lib/dock.js';

// ── Replayed Dock webhook (associatedObjects.formQuestions + responses) ──
// Source: dock-webhook 200 at 2026-06-17T18:48:38Z (event YtTw9jIsVlz0).
const QUESTIONS = [
  { id: 'USMfdn8Deeb0', title: 'Please select the Visa Product type for your card', type: 'dropdown' },
  { id: 'hKQZkcjZxiCS', title: 'Please select the type of custom card', type: 'dropdown' },
  { id: '9WBmeqRzhz8N', title: 'Please submit your Card Art design file with the folowing requirements met:', type: 'file_upload' },
  { id: 'ZplQWQ85icZA', title: 'Please submit your Icon design file with the followng requirements:', type: 'file_upload' },
  { id: '3l6bbF6QrPTr', title: 'Background Color', type: 'single_line' },
  { id: 'HyVqm0s08xY5', title: 'Foreground Color', type: 'single_line' },
  { id: 'SHvgtbLEZNYD', title: 'Label Color', type: 'single_line' },
  { id: 'gE06PQl3jOzm', title: 'Card Name', type: 'single_line' },
];
const RESPONSES = [
  { formQuestionId: 'hKQZkcjZxiCS', value: ['Custom Virtual'] },
  {
    formQuestionId: '9WBmeqRzhz8N',
    value: ['ChatGPT Image May 31, 2026, 10_14_59 PM.png'],
    files: [{
      name: 'ChatGPT Image May 31, 2026, 10_14_59 PM.png',
      url: 'https://storage.googleapis.com/dock-production-public/form/IjabEvsLxAjn/8d8b8b6f-bb7e-4c4c-9ca4-53da9380001c.png?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=google-cloud%40striking-loop-301921.iam.gserviceaccount.com%2F20260617%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20260617T184838Z&X-Goog-Expires=3600&X-Goog-SignedHeaders=host&response-content-disposition=attachment%3B%20filename%3D%22ChatGPT%20Image%20May%2031%2C%202026%2C%2010_14_59%20PM.png%22&X-Goog-Signature=87ce3db95008c8c1641a90c32a0a37f167f6bd862d5e83b42f3effb24f929fc8b91e198c7067ef0e8e2fb8149e27ce9438cd192361f9740def18ca43da7a43d125f9110541902bdd7b09a352b7cea91f1cdb21c97c396b97e4a298b4c18e5855898d37b9562cd6ca427a25a8d830d56b90b22a8868587d6627819c1ea0b4d44f6d4f59d33c458c1365a6de1ede4c0991ba515542dc6dbdcd716a8f4c0b9ed53ef264ddf45a1c15555224d4cd1d87dccf8535a98957fc9be37dce8b3156389661a93623a867e1185b837fceba6610271e078f7a2aaa144ab8fbbba2dc774c7bd595b6c13879040045b650aa6498e02b8d05dcca3a5dfd0a2dfdd86600d7edfa73',
    }],
  },
];

async function main() {
  const cardArt = extractCardArtFile(QUESTIONS, RESPONSES);
  if (!cardArt) throw new Error('No card-art file found in payload');
  const { fileName } = cardArt;
  const cardArtUrl = process.argv[2] || cardArt.url; // allow a fresh URL override
  const cardType = cardTypeFromForm(QUESTIONS, RESPONSES);

  console.log(`[dry-run] card-art file: ${fileName}`);
  console.log(`[dry-run] card type (from form answer): ${cardType ?? '(infer from extension)'}`);

  // argv[2] may be a fresh signed URL OR a local file path (signed URLs expire
  // ~1h after the webhook, so a cached file lets you re-run later).
  let buffer;
  if (process.argv[2] && existsSync(process.argv[2])) {
    console.log(`[dry-run] reading card art from local file: ${process.argv[2]}`);
    buffer = await readFile(process.argv[2]);
  } else {
    console.log('[dry-run] downloading card art from signed URL…');
    const res = await fetch(cardArtUrl);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} (URL may have expired — pass a fresh URL or a local file path as argv[2])`);
    buffer = Buffer.from(await res.arrayBuffer());
  }
  console.log(`[dry-run] card art is ${buffer.length} bytes`);

  console.log('[dry-run] running analysis pipeline (no delivery)…');
  const { pdfBuffer, status, summary, results, cardType: resolvedType } = await runAnalysis({
    file: buffer,
    fileName,
    cardType,
    onProgress: (event, data) => {
      if (event === 'progress') console.log(`  · ${data.step}: ${data.message} (${data.status})`);
      if (event === 'agent_tool') console.log(`  · tool: ${data.tool}${data.command ? ' → ' + String(data.command).slice(0, 80) : ''}`);
    },
  });

  const outPath = '/tmp/dock-dry-run-report.pdf';
  await writeFile(outPath, pdfBuffer);

  console.log('\n──────── RESULT ────────');
  console.log(`card type : ${resolvedType}`);
  console.log(`status    : ${status}`);
  console.log(`summary   : ${summary}`);
  console.log(`report    : ${outPath} (${pdfBuffer.length} bytes)`);
  console.log(`results.status: ${results?.status}`);
  console.log('PDF report generated successfully from the Dock webhook payload.');
}

main().catch((err) => {
  console.error('[dry-run] FAILED:', err);
  process.exit(1);
});

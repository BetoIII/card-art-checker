import Busboy from 'busboy';
import { runAnalysis } from '../lib/pipeline.js';
import { storeReport } from '../lib/blob-report.js';
import { inferCardType, extOf } from '../lib/card-type.js';
import { getProjectName } from '../lib/rocketlane.js';
import { createRunLog } from '../lib/run-log.js';

// ── Multipart parser ─────────────────────────────────────────────────

const VALID_CARD_TYPES = new Set(['virtual', 'physical']);
// Physical submissions may be vector source files (.ai/.eps) or PNG.
const PHYSICAL_EXTS = new Set(['.ai', '.eps', '.png']);

function parseMultipart(request) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers.get('content-type') || '';
    const bb = Busboy({ headers: { 'content-type': contentType } });

    const fileChunks = { file: [], backFile: [] };
    const fileNames = { file: '', backFile: '' };
    let projectId = '';
    let cardType = '';
    let slackDelivery = true;

    bb.on('file', (fieldname, stream, info) => {
      const key = fieldname === 'backFile' ? 'backFile' : 'file';
      fileNames[key] = info.filename || '';
      stream.on('data', (chunk) => fileChunks[key].push(chunk));
    });

    bb.on('field', (name, value) => {
      if (name === 'projectId') projectId = value;
      else if (name === 'cardType') cardType = (value || '').trim().toLowerCase();
      else if (name === 'slackDelivery') slackDelivery = !/^(false|0|no|off)$/i.test((value || '').trim());
    });

    bb.on('finish', () => {
      clearTimeout(timeout);

      const fileBuffer = fileChunks.file.length ? Buffer.concat(fileChunks.file) : null;
      const backBuffer = fileChunks.backFile.length ? Buffer.concat(fileChunks.backFile) : null;

      if (!fileBuffer) return reject(new Error('No file uploaded'));
      if (!projectId) return reject(new Error('Missing projectId'));

      // cardType is now OPTIONAL — we'll infer from the filename if absent.
      // If supplied, it must be a known value.
      if (cardType && !VALID_CARD_TYPES.has(cardType)) {
        return reject(new Error(`Invalid cardType "${cardType}" — must be "virtual" or "physical"`));
      }

      const resolvedCardType = cardType || inferCardType(fileNames.file);
      if (!resolvedCardType) {
        return reject(new Error(
          `Could not infer card type from "${fileNames.file}" — pass cardType=virtual|physical explicitly`
        ));
      }

      if (resolvedCardType === 'virtual') {
        if (backBuffer) {
          return reject(new Error('backFile is only valid for physical submissions'));
        }
      } else {
        const frontExt = extOf(fileNames.file);
        if (!PHYSICAL_EXTS.has(frontExt)) {
          return reject(new Error(`Physical front file must be .ai, .eps, or .png; got ${frontExt || 'unknown'}`));
        }
        if (backBuffer) {
          const backExt = extOf(fileNames.backFile);
          if (!PHYSICAL_EXTS.has(backExt)) {
            return reject(new Error(`Physical back file must be .ai, .eps, or .png; got ${backExt || 'unknown'}`));
          }
        }
      }

      resolve({
        file: fileBuffer,
        fileName: fileNames.file,
        backFile: backBuffer,
        backFileName: fileNames.backFile,
        projectId,
        cardType: resolvedCardType,
        slackDelivery,
      });
    });

    bb.on('error', (err) => { clearTimeout(timeout); reject(err); });

    const timeout = setTimeout(() => {
      reject(Object.assign(new Error('Multipart parse timed out'), { step: 'upload' }));
    }, 30_000);

    const reader = request.body.getReader();
    const writable = bb;

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { writable.end(); break; }
          writable.write(Buffer.from(value));
        }
      } catch (err) { reject(err); }
    })();
  });
}

// ── Main handler ─────────────────────────────────────────────────────

export async function POST(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return new Response('Bad request: expected multipart/form-data', { status: 400 });
  }

  // Record the run for the /admin dashboard. Progress events mirror the SSE
  // stream; only 'progress' events are persisted (agent deltas are too chatty).
  const runLog = createRunLog({
    source: 'upload',
    trigger: {
      endpoint: '/api/card-check',
      description: 'Manual upload via /upload',
      userAgent: request.headers.get('user-agent') || undefined,
    },
  });
  runLog.armWatchdog(300_000); // keep in sync with config.maxDuration below
  request.signal?.addEventListener('abort', () => {
    runLog.abandon('Client disconnected before the run finished');
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, data) => {
        // enqueue throws once the client has cancelled the stream — the run
        // log must still get its terminal write, so never let that propagate.
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* client gone; keep the pipeline + run log going */ }
        if (event === 'progress') runLog.event(data.step, data.message, data.status);
      };

      try {
        send('progress', { step: 'upload', message: 'Receiving file...', status: 'pending' });

        const { file, fileName, backFile, backFileName, projectId, cardType, slackDelivery } = await parseMultipart(request);
        send('progress', { step: 'upload', message: 'File received', status: 'done' });
        runLog.set({ projectId, cardType, file: fileName, ...(backFileName ? { backFile: backFileName } : {}) });

        send('progress', { step: 'rocketlane', message: 'Looking up project details...', status: 'pending' });
        const projectName = await getProjectName(projectId);
        send('progress', { step: 'rocketlane', message: `Project: ${projectName}`, status: 'done' });
        runLog.set({ projectName });

        const { pdfBuffer, status, summary } = await runAnalysis({
          file,
          fileName,
          backFile,
          backFileName,
          cardType,
          onProgress: send,
        });

        send('progress', { step: 'blob_upload', message: 'Storing report...', status: 'pending' });
        const { pdfUrl } = await storeReport({ pdfBuffer, projectId });
        send('progress', { step: 'blob_upload', message: 'Report stored', status: 'done' });

        send('complete', {
          status,
          summary,
          cardType,
          pdfUrl,
          delivery: {
            projectId,
            projectName,
            pdfUrl,
            status,
            summary,
            cardType,
            slackDelivery,
          },
        });
        runLog.addResult({
          filename: fileName,
          cardType,
          status,
          summary,
          pdfUrl,
          // Slack delivery is a separate client-triggered call (/api/card-deliver).
          delivery: { slack: 'client-triggered' },
        });
        await runLog.finish();
      } catch (err) {
        send('error', { message: err.message || 'An unexpected error occurred', step: err.step });
        await runLog.fail(err);
      } finally {
        try { controller.close(); } catch { /* already closed/cancelled */ }
      }
    },
    cancel() {
      runLog.abandon('Client disconnected before the run finished');
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export const config = {
  maxDuration: 300,
};

import { put as blobPut, del as blobDel } from '@vercel/blob';

// Transport blobs are copies of the submitted card art that exist only so the
// spec-check self-call can fetch them by URL (the platform 413s request
// bodies over ~4.5MB). Nothing reads them once the analysis settles.
//
// withTransportBlobs(fn) hands fn a put() that records every upload, then
// deletes each recorded blob when fn settles, whether it returned or threw.
// The delete used to run only after the report render, so every run that
// threw before reaching it leaked its upload. Cleanup also waits out uploads
// still in flight: a run can fail while its put is pending.
//
// Cleanup is awaited, not fire-and-forget: the function instance can freeze
// once the response is sent, and a local eval run can exit. A failed upload
// is skipped (fn already saw its error); a failed delete is logged and never
// masks fn's own result or error.
export async function withTransportBlobs(fn, { put = blobPut, del = blobDel } = {}) {
  const uploads = [];
  const trackedPut = (...args) => {
    const upload = put(...args);
    uploads.push(upload);
    return upload;
  };
  try {
    return await fn(trackedPut);
  } finally {
    await Promise.all(uploads.map((upload) => upload.then(
      (blob) => del(blob.url).catch((err) => console.warn('transport blob cleanup failed:', err?.message || err)),
      () => {},
    )));
  }
}

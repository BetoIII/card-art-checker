import { put } from '@vercel/blob';

// Store a generated PDF report to Vercel Blob and return its permanent URL.
// Path scheme: reports/{projectId}/{timestamp}-report.pdf
export async function storeReport({ pdfBuffer, projectId }) {
  const blob = await put(`reports/${projectId}/${Date.now()}-report.pdf`, pdfBuffer, {
    access: 'public',
    contentType: 'application/pdf',
  });
  return { pdfUrl: blob.url };
}

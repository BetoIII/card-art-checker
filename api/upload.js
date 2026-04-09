import { put } from '@vercel/blob';

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid form data' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const file = formData.get('file');
  const projectId = formData.get('projectId');

  if (!file || !projectId) {
    return new Response(JSON.stringify({ error: 'Missing file or projectId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate file type
  if (file.type !== 'image/png') {
    return new Response(JSON.stringify({ error: 'Only PNG files are accepted' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate file size (10 MB max)
  if (file.size > 10 * 1024 * 1024) {
    return new Response(JSON.stringify({ error: 'File must be under 10 MB' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Upload to Vercel Blob
    const blob = await put(
      `uploads/${projectId}-${Date.now()}.png`,
      file,
      { access: 'public', addRandomSuffix: true }
    );

    // Trigger Zap 1 webhook with image URL + project ID
    const webhookUrl = process.env.ZAPIER_WEBHOOK_URL;
    if (webhookUrl) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: blob.url,
          projectId,
        }),
      });
    }

    return new Response(JSON.stringify({ success: true, imageUrl: blob.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[upload] Error:', err);
    return new Response(JSON.stringify({ error: 'Upload processing failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

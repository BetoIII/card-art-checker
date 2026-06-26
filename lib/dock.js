// Helpers for turning a Dock `workspace.form.submitted` event into card-art
// pipeline inputs.
//
// Dock delivers the uploaded design file as a signed GCS URL inside
// formQuestionResponses[].files[] (host storage.googleapis.com/...,
// GOOG4-RSA-SHA256 signed, expires ~1h after delivery — fetch promptly).
// The form has TWO file_upload questions (Card Art + Icon), so selection must
// be by question title, not "first file answer".

// Pick the card-art file_upload answer. Prefers the question titled "Card Art";
// falls back to the first file answer so a title wording change still yields a
// file rather than nothing. Returns { fileName, url } or null.
export function extractCardArtFile(questions = [], responses = []) {
  const titleById = Object.fromEntries((questions || []).map((q) => [q.id, q.title || '']));
  const fileAnswers = (responses || []).filter((r) => Array.isArray(r.files) && r.files.length);
  if (!fileAnswers.length) return null;
  const cardArt =
    fileAnswers.find((r) => /card\s*art/i.test(titleById[r.formQuestionId])) || fileAnswers[0];
  const file = cardArt.files[0];
  if (!file?.url) return null;
  return { fileName: file.name, url: file.url };
}

// Derive the virtual/physical override from the "type of custom card" answer.
// Returns 'virtual' | 'physical' | undefined (undefined ⇒ let the filename
// extension decide in inferCardType).
export function cardTypeFromForm(questions = [], responses = []) {
  const titleById = Object.fromEntries((questions || []).map((q) => [q.id, q.title || '']));
  const typeAns = (responses || []).find((r) => /type of custom card/i.test(titleById[r.formQuestionId]));
  const raw = String(typeAns?.value?.[0] || '').toLowerCase();
  if (raw.includes('virtual')) return 'virtual';
  if (raw.includes('physical') || raw.includes('plastic') || raw.includes('metal')) return 'physical';
  return undefined;
}

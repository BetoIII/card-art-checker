// Infer virtual vs physical card type from a filename, with optional override.
//
// Rules:
//   .ai, .eps           → physical (always — vector sources are physical-only)
//   .png                → virtual unless override === 'physical'
//                         (Rain's physical template accepts PNG too, but virtual
//                          is the safe default; callers can force physical)
//   anything else       → null (caller decides whether to error)
//
// The override wins for .png and is ignored for unambiguous vector formats —
// no caller should ever ask to run a .ai file as "virtual" by accident.

const PHYSICAL_EXTS = new Set(['.ai', '.eps']);
const VIRTUAL_EXTS = new Set(['.png']);
const VALID_OVERRIDES = new Set(['virtual', 'physical']);

export function extOf(filename) {
  const m = /\.[a-z0-9]+$/i.exec(filename || '');
  return m ? m[0].toLowerCase() : '';
}

export function inferCardType(filename, override) {
  const o = (override || '').trim().toLowerCase();
  if (o && !VALID_OVERRIDES.has(o)) {
    throw new Error(`Invalid cardType override "${override}" — must be "virtual" or "physical"`);
  }

  const ext = extOf(filename);

  if (PHYSICAL_EXTS.has(ext)) return 'physical';
  if (VIRTUAL_EXTS.has(ext)) return o === 'physical' ? 'physical' : 'virtual';

  if (o) return o;
  return null;
}

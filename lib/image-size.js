// Minimal image-dimension reader — enough to tell a card-art design (large,
// e.g. 1536×969) apart from a logo/icon (small, e.g. 174×219 or 100×100) from
// the file header alone, without decoding the whole image. Supports the raster
// formats the form accepts (PNG/JPEG/GIF/WEBP). Returns { width, height } or
// null when the format isn't recognized (e.g. vector .ai/.eps/.pdf).

export function getImageSize(buf) {
  if (!buf || buf.length < 24) return null;

  // PNG: 8-byte signature, then IHDR with width@16, height@20 (big-endian).
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF: "GIF87a"/"GIF89a", width@6, height@8 (little-endian).
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WEBP (VP8X/VP8/VP8L) inside a RIFF container.
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      return {
        width: 1 + (buf.readUIntLE(24, 3) & 0xffffff),
        height: 1 + (buf.readUIntLE(27, 3) & 0xffffff),
      };
    }
    if (fourcc === 'VP8 ') {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    // VP8L and others: skip rather than misreport.
  }

  // JPEG: walk the marker segments to the Start-Of-Frame, which carries the
  // dimensions (height@+5, width@+7 relative to the marker byte).
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0..SOF15 carry frame size; DHT(C4)/DAC(CC)/RST are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2; // markers with no length payload
        continue;
      }
      off += 2 + buf.readUInt16BE(off + 2); // skip this segment
    }
  }

  return null;
}

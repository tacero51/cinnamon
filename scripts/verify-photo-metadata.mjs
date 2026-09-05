import exifr from 'exifr';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function hasGpsCoordinates(gps) {
  return Boolean(gps
    && typeof gps === 'object'
    && Number.isFinite(gps.latitude)
    && Number.isFinite(gps.longitude));
}

function isWebPRiff(bytes) {
  return bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';
}

function inspectWebPMetadata(bytes) {
  if (bytes.length < 12) throw new Error('invalid WebP header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredLength = view.getUint32(4, true) + 8;
  if (declaredLength !== bytes.length) throw new Error('invalid WebP RIFF length');

  const metadataChunks = [];
  let hasImagePayload = false;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('truncated WebP chunk header');
    const chunkName = Buffer.from(bytes.subarray(offset, offset + 4)).toString('ascii');
    const chunkLength = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkLength > bytes.length - offset) throw new Error('truncated WebP chunk');
    if (chunkName === 'EXIF' || chunkName === 'XMP ' || chunkName === 'ICCP') metadataChunks.push(chunkName);
    if (chunkName === 'VP8 ' || chunkName === 'VP8L' || chunkName === 'ANMF') hasImagePayload = true;
    offset += chunkLength;
    if (chunkLength % 2 === 1) offset += 1;
    if (offset > bytes.length) throw new Error('truncated WebP chunk padding');
  }
  if (offset !== bytes.length) throw new Error('invalid WebP chunk alignment');
  if (!hasImagePayload) throw new Error('WebP has no image payload');
  return { keys: metadataChunks, hasGps: false };
}

async function localBytes(file) {
  if (file instanceof Uint8Array) return file;
  if (file instanceof ArrayBuffer) return new Uint8Array(file);
  if (typeof file === 'string' || file instanceof URL) return new Uint8Array(await readFile(file));
  return null;
}

export async function inspectPhotoMetadata(file) {
  const bytes = await localBytes(file);
  if (bytes && isWebPRiff(bytes)) return inspectWebPMetadata(bytes);

  const [metadata, gps] = await Promise.all([
    exifr.parse(file, { exif: true, gps: true, xmp: true, iptc: true, icc: true, jfif: true }),
    exifr.gps(file),
  ]);
  const keys = Object.keys(metadata || {});
  return { keys, hasGps: hasGpsCoordinates(gps) };
}

export async function verifyPhotoMetadata(files, { log = console } = {}) {
  let unsafe = false;
  for (const file of files) {
    try {
      const { keys, hasGps } = await inspectPhotoMetadata(file);
      const name = typeof file === 'string' ? path.basename(file) : 'image';

      if (keys.length > 0 || hasGps) {
        unsafe = true;
        log.error(`${name}: metadata remains (${hasGps ? 'GPS' : keys.join(', ')})`);
      } else {
        log.log(`${name}: no readable EXIF/XMP/IPTC/GPS metadata`);
      }
    } catch {
      unsafe = true;
      const name = typeof file === 'string' ? path.basename(file) : 'image';
      log.error(`${name}: metadata verification failed`);
    }
  }
  return !unsafe;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: node verify-photo-metadata.mjs <image-file> [...]');
    process.exitCode = 2;
    return;
  }

  if (!(await verifyPhotoMetadata(files))) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

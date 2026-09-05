import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { hasGpsCoordinates, inspectPhotoMetadata } from '../scripts/verify-photo-metadata.mjs';

// 2×2 pxのメタデータなしWebP。外部の画像変換コマンドに依存せず検証するためのfixture。
const CLEAN_WEBP = Buffer.from(
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAgA0JaACdLoB+AADsAD+8Oj3/yC5YXXI1/8gP+QH/ID/+PIAAAA=',
  'base64',
);

const BASE_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ap//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
);

function appendWebPChunk(webp, name, payload) {
  const paddingLength = payload.length % 2;
  const result = Buffer.alloc(webp.length + 8 + payload.length + paddingLength);
  webp.copy(result, 0);
  result.write(name, webp.length, 4, 'ascii');
  result.writeUInt32LE(payload.length, webp.length + 4);
  payload.copy(result, webp.length + 8);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function makeGpsJpeg() {
  const tiff = Buffer.alloc(128);
  tiff.write('II', 0, 2, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);

  // IFD0: GPSInfoIFDPointer → offset 26
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);

  const gpsIfd = 26;
  tiff.writeUInt16LE(4, gpsIfd);
  const writeAsciiEntry = (offset, tag, value) => {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(2, offset + 2);
    tiff.writeUInt32LE(2, offset + 4);
    tiff.write(`${value}\0`, offset + 8, 2, 'ascii');
  };
  const writeRationalEntry = (offset, tag, dataOffset) => {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(5, offset + 2);
    tiff.writeUInt32LE(3, offset + 4);
    tiff.writeUInt32LE(dataOffset, offset + 8);
  };
  writeAsciiEntry(gpsIfd + 2, 0x0001, 'N');
  writeRationalEntry(gpsIfd + 14, 0x0002, 80);
  writeAsciiEntry(gpsIfd + 26, 0x0003, 'E');
  writeRationalEntry(gpsIfd + 38, 0x0004, 104);
  tiff.writeUInt32LE(0, gpsIfd + 50);

  const writeCoordinate = (offset, degrees) => {
    for (const [index, value] of [degrees, 0, 0].entries()) {
      tiff.writeUInt32LE(value, offset + index * 8);
      tiff.writeUInt32LE(1, offset + index * 8 + 4);
    }
  };
  writeCoordinate(80, 35);
  writeCoordinate(104, 139);

  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(exifPayload.length + 4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exifPayload.length + 2, 2);
  exifPayload.copy(app1, 4);
  return Buffer.concat([BASE_JPEG.subarray(0, 2), app1, BASE_JPEG.subarray(2)]);
}

test('detects the object-shaped GPS result returned by exifr', () => {
  assert.equal(hasGpsCoordinates({ latitude: 35.681236, longitude: 139.767125 }), true);
});

test('does not mistake incomplete or absent GPS metadata for a coordinate', () => {
  assert.equal(hasGpsCoordinates(undefined), false);
  assert.equal(hasGpsCoordinates({ latitude: 35.681236 }), false);
  assert.equal(hasGpsCoordinates([35.681236, 139.767125]), false);
});

test('accepts a clean WebP and rejects EXIF/XMP chunks', async () => {
  assert.deepEqual(await inspectPhotoMetadata(CLEAN_WEBP), { keys: [], hasGps: false });

  const exifWebp = appendWebPChunk(CLEAN_WEBP, 'EXIF', Buffer.from('Exif\0\0', 'ascii'));
  assert.deepEqual(await inspectPhotoMetadata(exifWebp), { keys: ['EXIF'], hasGps: false });

  const xmpWebp = appendWebPChunk(CLEAN_WEBP, 'XMP ', Buffer.from('<x:xmpmeta/>', 'utf8'));
  assert.deepEqual(await inspectPhotoMetadata(xmpWebp), { keys: ['XMP '], hasGps: false });
});

test('fails closed for malformed or image-less WebP data', async () => {
  await assert.rejects(() => inspectPhotoMetadata(CLEAN_WEBP.subarray(0, -1)), /invalid WebP RIFF length/);

  const emptyRiff = Buffer.alloc(12);
  emptyRiff.write('RIFF', 0, 4, 'ascii');
  emptyRiff.writeUInt32LE(4, 4);
  emptyRiff.write('WEBP', 8, 4, 'ascii');
  await assert.rejects(() => inspectPhotoMetadata(emptyRiff), /WebP has no image payload/);
});

test('detects GPS in a JPEG EXIF fixture', async () => {
  const result = await inspectPhotoMetadata(makeGpsJpeg());
  assert.equal(result.hasGps, true);
});

test('CLI only succeeds for a clean metadata-free WebP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cinnamon-photo-metadata-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));

  const cleanPath = join(directory, 'clean.webp');
  const exifPath = join(directory, 'exif.webp');
  const brokenPath = join(directory, 'broken.webp');
  const gpsPath = join(directory, 'gps.jpg');
  await Promise.all([
    writeFile(cleanPath, CLEAN_WEBP),
    writeFile(exifPath, appendWebPChunk(CLEAN_WEBP, 'EXIF', Buffer.from('Exif\0\0', 'ascii'))),
    writeFile(brokenPath, CLEAN_WEBP.subarray(0, -1)),
    writeFile(gpsPath, makeGpsJpeg()),
  ]);

  const script = fileURLToPath(new URL('../scripts/verify-photo-metadata.mjs', import.meta.url));
  const run = (file) => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });

  const clean = run(cleanPath);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  for (const file of [exifPath, brokenPath, gpsPath]) {
    const result = run(file);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

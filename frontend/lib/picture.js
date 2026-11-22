// Makes a recipe's picture from a file the user chose (the edit form, or a photo import's
// photo): a full JPEG for the recipe's page and a small thumb for the cards, both drawn
// here with a canvas, so the backend stores them as they are and no quota is used.

import { ApiError } from './api';

// The longer side of the full picture, and the shorter side of the thumb (the card crops
// it to a square). The same sizes the backend gives a link's picture.
export const FULL_SIDE = 1280;
export const THUMB_SIDE = 240;
// The backend's limits (backend/src/pictures.js).
const MAX_FULL_BYTES = 1000000;
const MAX_THUMB_BYTES = 100000;
const QUALITIES = [0.82, 0.65, 0.5];

// The scale for the full picture (never enlarged) and for the thumb.
export function pictureScales(width, height) {
  return {
    full: Math.min(1, FULL_SIDE / Math.max(width, height)),
    thumb: Math.min(1, THUMB_SIDE / Math.min(width, height)),
  };
}

function draw(bitmap, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toJpeg = (canvas, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/jpeg', quality);
  });

// The best quality that fits the limit, or null.
async function fitting(canvas, maxBytes) {
  for (const quality of QUALITIES) {
    const blob = await toJpeg(canvas, quality);
    if (blob.size <= maxBytes) return blob;
  }
  return null;
}

// Returns { full, thumb }, two JPEG Blobs. createImageBitmap applies the photo's EXIF
// rotation, so it stays upright. Throws ApiError picture_invalid for a file the browser
// can't draw (not a picture, or a HEIC most browsers can't decode).
export async function makePicture(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ApiError(400, 'picture_invalid');
  }
  try {
    const scales = pictureScales(bitmap.width, bitmap.height);
    const full = await fitting(draw(bitmap, scales.full), MAX_FULL_BYTES);
    const thumb = await fitting(draw(bitmap, scales.thumb), MAX_THUMB_BYTES);
    if (!full || !thumb) throw new ApiError(413, 'picture_too_big');
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}

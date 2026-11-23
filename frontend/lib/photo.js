// Gets a chosen picture ready to send. It is sent as it is, so the model can read small
// print: phone photos and screenshots are far below the limit, and Gemini scales every
// image down itself anyway. Only a huge file (a 100+ megapixel camera mode) is shrunk here
// first, to a size that still holds more detail than the model looks at.

import { ApiError } from './api';

// Sent unchanged up to this size; the backend takes up to 20 MB.
export const SEND_AS_IS_BYTES = 15 * 1024 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
// Several photos of one recipe go in one request, which the backend takes up to 50 MB;
// this leaves room for the multipart wrapping.
export const MAX_PHOTOS = 7;
export const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const RESIZE_TO_PX = 4096;
const JPEG_QUALITY = 0.92;

const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
// Some browsers (Chrome on Windows) give a HEIC file no type, so its name says what it is.
const TYPE_BY_EXTENSION = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };

function typeOf(file) {
  if (TYPES.includes(file.type)) return file.type;
  if (file.type) return null;
  return TYPE_BY_EXTENSION[file.name?.split('.').pop()?.toLowerCase()] ?? null;
}

// Draws the picture again at `RESIZE_TO_PX` on its longest side. createImageBitmap applies
// the photo's EXIF rotation, so the text stays upright.
async function shrink(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, RESIZE_TO_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/jpeg', JPEG_QUALITY);
  });
}

// Returns the Blob to send, with an image type the backend takes. Throws ApiError
// photo_invalid for a file that isn't such a picture, and photo_too_big for a huge one
// the browser can't shrink (a HEIC most browsers can't decode).
export async function preparePhoto(file) {
  const type = typeOf(file);
  if (!type || file.size === 0) throw new ApiError(400, 'photo_invalid');
  if (file.size <= SEND_AS_IS_BYTES) return file.type === type ? file : new Blob([file], { type });
  let smaller;
  try {
    smaller = await shrink(file);
  } catch {
    throw new ApiError(413, 'photo_too_big');
  }
  if (smaller.size > MAX_BYTES) throw new ApiError(413, 'photo_too_big');
  return smaller;
}

const totalSize = (photos) => photos.reduce((sum, photo) => sum + photo.size, 0);

// Gets 1 to 7 chosen pictures ready to send together, in order. Seven phone photos are far
// below the limit; only if they're not (big camera files) is every one over a few MB
// shrunk too, which still holds more detail than the model looks at. Throws as
// preparePhoto does, and photo_too_many for more than 7.
export async function preparePhotos(files) {
  if (files.length === 0) throw new ApiError(400, 'photo_invalid');
  if (files.length > MAX_PHOTOS) throw new ApiError(400, 'photo_too_many');
  let photos = [];
  for (const file of files) photos.push(await preparePhoto(file));
  if (totalSize(photos) <= MAX_TOTAL_BYTES) return photos;
  try {
    photos = await Promise.all(photos.map((photo) => (photo.size > MAX_TOTAL_BYTES / MAX_PHOTOS ? shrink(photo) : photo)));
  } catch {
    throw new ApiError(413, 'photo_too_big');
  }
  if (totalSize(photos) > MAX_TOTAL_BYTES) throw new ApiError(413, 'photo_too_big');
  return photos;
}

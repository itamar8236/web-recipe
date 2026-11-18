import { describe, expect, it } from 'vitest';
import { preparePhoto, SEND_AS_IS_BYTES } from './photo';

const file = (bytes, type, name = 'recipe.jpg') => new File([new Uint8Array(bytes)], name, { type });

describe('preparePhoto', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])('returns a small %s file unchanged', async (type) => {
    const picture = file(1000, type);
    expect(await preparePhoto(picture)).toBe(picture);
  });

  it('sends a file of exactly the limit unchanged', async () => {
    const picture = file(SEND_AS_IS_BYTES, 'image/jpeg');
    expect(await preparePhoto(picture)).toBe(picture);
  });

  it('gives a HEIC file the browser left without a type its type from the name', async () => {
    const prepared = await preparePhoto(file(1000, '', 'IMG_0001.HEIC'));
    expect(prepared.type).toBe('image/heic');
    expect(prepared.size).toBe(1000);
  });

  it.each([
    ['a GIF', file(1000, 'image/gif', 'a.gif')],
    ['a PDF', file(1000, 'application/pdf', 'a.pdf')],
    ['a file with no type or known name', file(1000, '', 'notes')],
    ['an empty picture', file(0, 'image/jpeg')],
  ])('refuses %s as photo_invalid', async (_, picture) => {
    await expect(preparePhoto(picture)).rejects.toMatchObject({ code: 'photo_invalid' });
  });

  it('refuses a huge picture it cannot shrink as photo_too_big', async () => {
    // Node has no createImageBitmap, like a browser that can't decode the file.
    await expect(preparePhoto(file(SEND_AS_IS_BYTES + 1, 'image/heic'))).rejects.toMatchObject({ code: 'photo_too_big' });
  });
});

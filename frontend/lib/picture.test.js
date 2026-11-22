import { describe, expect, it } from 'vitest';
import { makePicture, pictureScales } from './picture';

describe('pictureScales', () => {
  it('shrinks the full picture to 1280 px on its longer side, and the thumb to 240 px on its shorter side', () => {
    expect(pictureScales(4000, 3000)).toEqual({ full: 0.32, thumb: 0.08 });
    expect(pictureScales(1080, 1920)).toEqual({ full: 1280 / 1920, thumb: 240 / 1080 });
  });

  it('never enlarges a small picture', () => {
    expect(pictureScales(200, 100)).toEqual({ full: 1, thumb: 1 });
  });
});

describe('makePicture', () => {
  it('refuses a file the browser cannot draw as picture_invalid', async () => {
    // Node has no createImageBitmap, like a browser that can't decode the file.
    const file = new File([new Uint8Array(10)], 'a.heic', { type: 'image/heic' });
    await expect(makePicture(file)).rejects.toMatchObject({ code: 'picture_invalid' });
  });
});

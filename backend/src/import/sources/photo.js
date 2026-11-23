// A photo the user uploaded (POST /api/imports/photo), not a link. It is never matched
// against pasted text, so `photo:<id>` can't be imported or scanned again as a link; only
// `sourceFor('photo')` finds it, for the stages. The pictures themselves are already in
// Gemini's file store (state.photos), so there is nothing to fetch.

export const PHOTO_PREFIX = 'photo:';

// Several photos of one recipe (its pages, or the recipe and the dish) are read together.
export const PHOTOS_MAX = 7;

export const photo = {
  platform: 'photo',
  matches: () => false,
  parse: () => null,
  async fetchPost(sourceId) {
    return { sourceId, sourceUrl: `${PHOTO_PREFIX}${sourceId}`, title: null, text: '', transcript: '', video: null };
  },
};

// Whether a stored source_url is a photo's, which is no link to show or open.
export const isPhotoSource = (sourceUrl) => typeof sourceUrl === 'string' && sourceUrl.startsWith(PHOTO_PREFIX);

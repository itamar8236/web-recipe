// Made-up Facebook and Instagram pages for the tests. They copy the structure of real
// pages saved on 2026-11-13 (the same nesting and field names, in <script
// type="application/json"> blocks among unrelated ones), with invented text, ids and links,
// so no real post or signed CDN link is kept in the repo.

const jsonScript = (data) => `<script type="application/json" data-content-len="1" data-sjs>${JSON.stringify(data)}</script>`;

// What surrounds the data on a real page: other scripts, and blocks that hold nothing useful.
const page = (head, ...blocks) =>
  `<!DOCTYPE html><html><head><title>Page</title>${head}</head><body>
<script>window.notJson = {"creation_story": true};</script>
${jsonScript({ require: [['Bootloader', 'handlePayload', null, [{ rsrcMap: {} }]]] })}
${blocks.join('\n')}
<script type="application/json">not json at all</script>
</body></html>`;

const wrap = (data) => ({ require: [['ScheduledServerJS', 'handle', null, [{ __bbox: { require: [['RelayPrepopulator', null, null, [{ __bbox: { result: { data } } }]]] } }]]] });

export const FB_ID = '857300000000001';
export const FB_OTHER_ID = '914700000000002';
export const FB_VIDEO_URL = 'https://video.fxyz1-1.fna.fbcdn.net/o1/v/t2/f2/m412/sd-file.mp4?_nc_cat=1&oe=ABC';
export const FB_SUBTITLES_URL = 'https://scontent.fxyz1-1.fna.fbcdn.net/v/t39.2093-6/subtitles_n.srt?_nc_cat=1';
export const FB_CAPTION =
  'Oven kebab\nA quick oven version of a street food classic: 500 g ground beef, 1 grated onion, 3 tbsp yogurt, bake 25 minutes.';

const fbPlayer = (id, { seconds, subtitlesUrl = null, videoUrl = FB_VIDEO_URL } = {}) => ({
  aspect_ratio: 0.5625,
  ...(seconds !== undefined && { length_in_second: seconds }),
  id,
  permalink_url: `https://www.facebook.com/reel/${id}/`,
  captions_url: subtitlesUrl,
  video_available_captions_locales: [],
  videoDeliveryLegacyFields: {
    dash_manifest_xml_string: '<?xml version="1.0"?><MPD></MPD>',
    browser_native_sd_url: videoUrl,
    browser_native_hd_url: videoUrl?.replace('sd-file', 'hd-file') ?? null,
    id,
  },
});

// The page a reel link or a share link ends on. It also carries the "more reels" feed,
// whose videos must not be mistaken for the one asked for.
export function facebookReelPage({ id = FB_ID, caption = FB_CAPTION, seconds = 28.5, subtitlesUrl = FB_SUBTITLES_URL, videoUrl = FB_VIDEO_URL } = {}) {
  const feedReel = {
    creation_story: { message: { text: 'Another reel, about something else entirely' } },
    short_form_video_context: { playback_video: fbPlayer(FB_OTHER_ID, { seconds: 600, videoUrl: 'https://video.fxyz1-1.fna.fbcdn.net/other.mp4' }) },
    id: FB_OTHER_ID,
  };
  const data = {
    viewer: { lasso_blue_feed: { edges: [{ node: feedReel }] } },
    video: {
      creation_story: {
        tracking: '{}',
        message: { text: caption, ranges: [] },
        short_form_video_context: {
          video: { id, playable_duration_in_ms: Math.round(seconds * 1000), owner: { id: '1000' } },
          playback_video: fbPlayer(id, { seconds, subtitlesUrl, videoUrl }),
        },
        video: { id, owner: { id: '1000' } },
      },
      id,
    },
  };
  return page('<meta property="og:title" content="1M views | Oven kebab" />', jsonScript({ extensions: { all_video_dash_prefetch_representations: [{ video_id: id }] } }), jsonScript(wrap(data)));
}

// The page /watch/?v=<id> redirects to: the same facts, split over two blocks, with the
// length given only in milliseconds.
export function facebookWatchPage({ id = FB_ID, caption = FB_CAPTION, seconds = 28.5 } = {}) {
  const player = { ...fbPlayer(id, { subtitlesUrl: null }), playable_duration_in_ms: Math.round(seconds * 1000), videoId: id };
  return page(
    '',
    jsonScript(wrap({ video: { story: { attachments: [{ media: player }] }, id } })),
    jsonScript(wrap({ id, title: { text: 'Oven kebab' }, creation_story: { debug_info: null, message: { text: caption } }, live_status: 'NEVER_LIVE' })),
  );
}

// What Facebook sends for an id that was removed, is private, or never existed.
export const facebookGonePage = () => page('', jsonScript(wrap({ video: null, viewer: { actor: { __typename: 'LoggedOutUser', id: '0' } } })));

export const IG_CODE = 'CxExampleA1';
export const IG_VIDEO_URL = 'https://instagram.fxyz1-1.fna.fbcdn.net/o1/v/t2/f2/m82/reel-file.mp4?_nc_cat=1';
export const IG_CAPTION = 'Eggplant salad\n2 large roasted eggplants, raw tahini, date syrup, salt. Spread the eggplant on a plate and drizzle everything on top.';

const igManifest = (duration) => `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="${duration}" FBManifestTimestamp="1"></MPD>`;

function instagramPage(media, gating = null) {
  const post = { __typename: 'XIGPolarisMedia', pk: '31915', code: media?.code ?? IG_CODE, if_not_gated_logged_out: media, gating_ruling: gating, id: 'POLARIS_31915' };
  return page('<meta property="og:title" content="Cook on Instagram" />', `<script>{"pageID":"postPage"}</script>`, jsonScript(wrap({ xig_polaris_media: post })));
}

// A reel (or any video post). `duration` is how the streaming manifest writes the length.
export function instagramReelPage({ code = IG_CODE, caption = IG_CAPTION, duration = 'PT37.5S', videoUrl = IG_VIDEO_URL } = {}) {
  return instagramPage({
    __typename: 'XIGPolarisVideoMedia',
    code,
    media_type: 2,
    product_type: 'clips',
    caption: caption === null ? null : { pk: '1', text: caption },
    video_dash_manifest: duration === null ? null : igManifest(duration),
    video_versions: [{ type: 101, url: videoUrl }, { type: 102, url: videoUrl }],
    // The same user's other posts ride along, and must not be mistaken for this one.
    user: { polaris_ordered_timeline_connection: { edges: [{ node: { code: 'DfOtherPost1', caption: { text: 'Another post' } } }] } },
  });
}

// A photo or carousel post: a caption and no video.
export function instagramCarouselPage({ code = IG_CODE, caption = IG_CAPTION } = {}) {
  return instagramPage({
    __typename: 'XIGPolarisCarouselMedia',
    code,
    media_type: 8,
    product_type: 'carousel_container',
    caption: { pk: '1', text: caption },
    carousel_media: [{ __typename: 'XIGPolarisImageMedia' }, { __typename: 'XIGPolarisImageMedia' }],
  });
}

// A post Instagram shows only after a login (an age limit, for example).
export const instagramGatedPage = () => instagramPage(null, { __typename: 'XIGGatingRuling' });

// What Instagram sends for a code that was removed or never existed.
export const instagramGonePage = () => page('', `<script>{"routeConfig":{"pageID":"httpErrorPage"},"url":"/p/x/"}</script>`);

export const instagramLoginPage = () => page('', `<script>{"routeConfig":{"pageID":"loginPage"}}</script>`);

// A page that came without its data blocks but still has the text link previews show.
export const previewOnlyPage = (title, description) =>
  `<!DOCTYPE html><html><head><meta property="og:title" content="${title}" /><meta property="og:description" content="${description}" /></head><body></body></html>`;

// A page with nothing a parser knows: what a block or a changed layout looks like.
export const emptyPage = () => '<!DOCTYPE html><html><head><title>Site</title></head><body><div id="root"></div></body></html>';

export const SRT = `1
00:00:00,000 --> 00:00:02,961
You tried the viral
kebab? It's a quick version

2
00:00:02,961 --> 00:00:05,841
to make in the oven.
`;

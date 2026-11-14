import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportError } from '../src/import/errors.js';
import { facebook } from '../src/import/sources/facebook.js';
import { readLink } from '../src/import/sources/index.js';
import { instagram } from '../src/import/sources/instagram.js';
import { openVideo } from '../src/import/sources/meta.js';
import {
  emptyPage,
  facebookGonePage,
  facebookReelPage,
  facebookWatchPage,
  FB_CAPTION,
  FB_ID,
  FB_SUBTITLES_URL,
  FB_VIDEO_URL,
  IG_CAPTION,
  IG_CODE,
  IG_VIDEO_URL,
  instagramCarouselPage,
  instagramGatedPage,
  instagramGonePage,
  instagramLoginPage,
  instagramReelPage,
  previewOnlyPage,
  SRT,
} from './meta-pages.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FB_WATCH = `https://www.facebook.com/watch/?v=${FB_ID}`;
const IG_POST = `https://www.instagram.com/p/${IG_CODE}/`;

const html = (body, status = 200) => new Response(body, { status });
const redirect = (location, status = 302) => new Response(null, { status, headers: { location } });

// Answers each request from `routes`, keyed by the start of its URL; anything else fails
// the test, so a request to an unexpected place can't go unnoticed.
const stubSite = (routes) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const key = Object.keys(routes).find((start) => String(url).startsWith(start));
      if (!key) throw new Error(`unexpected request: ${url}`);
      const answer = routes[key];
      return typeof answer === 'function' ? answer() : answer;
    }),
  );
const requested = () => fetch.mock.calls.map(([url]) => String(url));
const failure = (promise) => promise.catch((error) => error);

describe('Facebook links', () => {
  it.each([
    `https://www.facebook.com/reel/${FB_ID}`,
    `https://www.facebook.com/reel/${FB_ID}/?mibextid=abc&rdid=xyz&share_url=https%3A%2F%2Fevil.example`,
    `https://facebook.com/reel/${FB_ID}/`,
    `https://m.facebook.com/reel/${FB_ID}/`,
    `https://web.facebook.com/reel/${FB_ID}`,
    `https://www.facebook.com/watch/?v=${FB_ID}`,
    `https://www.facebook.com/watch?v=${FB_ID}&extra=1`,
    `https://www.facebook.com/video.php?v=${FB_ID}`,
    `https://www.facebook.com/somecook/videos/${FB_ID}/`,
    `https://www.facebook.com/somecook/videos/oven-kebab/${FB_ID}/`,
    `https://www.facebook.com/some.cook/videos/%D7%A7%D7%A8%D7%99%D7%A1%D7%A4%D7%99/${FB_ID}/?idorvanity=1`,
    `  https://WWW.FACEBOOK.COM/reel/${FB_ID}  `,
  ])('reads %s as the video, and stores a link rebuilt from its id', (text) => {
    const link = readLink(text);
    expect(link.source).toBe(facebook);
    expect(link.sourceId).toBe(FB_ID);
    expect(link.sourceUrl).toBe(FB_WATCH);
  });

  it.each([
    ['https://www.facebook.com/share/r/1EQtF8caYG/', 'share/r/1EQtF8caYG', 'https://www.facebook.com/share/r/1EQtF8caYG/'],
    ['https://www.facebook.com/share/v/1EAG5J9uQe/?mibextid=wwXIfr', 'share/v/1EAG5J9uQe', 'https://www.facebook.com/share/v/1EAG5J9uQe/'],
    ['https://m.facebook.com/share/p/1AbCdEfGhI', 'share/p/1AbCdEfGhI', 'https://www.facebook.com/share/p/1AbCdEfGhI/'],
    ['https://www.facebook.com/share/1AbCdEfGhI/', 'share/1AbCdEfGhI', 'https://www.facebook.com/share/1AbCdEfGhI/'],
    ['https://fb.watch/abc-DEF_12/', 'fb.watch/abc-DEF_12', 'https://fb.watch/abc-DEF_12/'],
  ])('keeps the share link %s until the import follows it', (text, sourceId, sourceUrl) => {
    expect(readLink(text)).toMatchObject({ source: facebook, sourceId, sourceUrl });
  });

  it.each([
    ['a profile', 'https://www.facebook.com/somecook'],
    ['the home page', 'https://www.facebook.com/'],
    ['a photo', 'https://www.facebook.com/photo/?fbid=701571188226405&set=a.263704305346431'],
    ['a post', 'https://www.facebook.com/somecook/posts/pfbid02abc'],
    ['a group', 'https://www.facebook.com/groups/123456789/'],
    ['a reel with letters in its id', 'https://www.facebook.com/reel/12345abc'],
    ['a too-short id', 'https://www.facebook.com/reel/123'],
    ['watch without an id', 'https://www.facebook.com/watch/'],
    ['extra path after a reel', `https://www.facebook.com/reel/${FB_ID}/more`],
    ['a share kind that does not exist', 'https://www.facebook.com/share/x/1AbCdEfGhI/'],
    ['a share link with a bad code', 'https://www.facebook.com/share/r/a%20b/'],
    ['fb.watch with extra path', 'https://fb.watch/abcdef/more'],
    ['the fb.watch home page', 'https://fb.watch/'],
  ])('refuses %s as link_invalid', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_invalid' });
  });

  it.each([
    ['a lookalike host', `https://facebook.com.evil.com/reel/${FB_ID}`],
    ['a host that ends the same', `https://notfacebook.com/reel/${FB_ID}`],
    ['a subdomain not on the list', `https://business.facebook.com/reel/${FB_ID}`],
    ['a user-info trick', `https://www.facebook.com@evil.com/reel/${FB_ID}`],
    ['a fb.watch lookalike', 'https://fb.watch.evil.com/abcdef/'],
  ])('refuses %s as link_unsupported', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_unsupported' });
  });
});

describe('Instagram links', () => {
  it.each([
    `https://www.instagram.com/reel/${IG_CODE}/`,
    `https://www.instagram.com/reel/${IG_CODE}/?igsh=N3VkbWdraHdwZm14&stkn=abc`,
    `https://instagram.com/reels/${IG_CODE}`,
    `https://www.instagram.com/p/${IG_CODE}/?img_index=2`,
    `https://www.instagram.com/tv/${IG_CODE}/`,
    `https://www.instagram.com/some.cook/reel/${IG_CODE}/`,
    `https://www.instagram.com/some.cook/p/${IG_CODE}/`,
    `https://instagr.am/p/${IG_CODE}/`,
  ])('reads %s as the post, and stores a link rebuilt from its code', (text) => {
    const link = readLink(text);
    expect(link.source).toBe(instagram);
    expect(link.sourceId).toBe(IG_CODE);
    expect(link.sourceUrl).toBe(IG_POST);
  });

  it.each([
    ['https://www.instagram.com/share/reel/BAxyz12345', 'share/reel/BAxyz12345', 'https://www.instagram.com/share/reel/BAxyz12345/'],
    ['https://www.instagram.com/share/p/BAxyz12345/?igsh=1', 'share/p/BAxyz12345', 'https://www.instagram.com/share/p/BAxyz12345/'],
    ['https://www.instagram.com/share/BAxyz12345', 'share/BAxyz12345', 'https://www.instagram.com/share/BAxyz12345/'],
  ])('keeps the share link %s until the import follows it', (text, sourceId, sourceUrl) => {
    expect(readLink(text)).toMatchObject({ source: instagram, sourceId, sourceUrl });
  });

  it.each([
    ['a profile', 'https://www.instagram.com/somecook/'],
    ['the home page', 'https://www.instagram.com/'],
    ['a story', 'https://www.instagram.com/stories/somecook/3191546060572407530/'],
    ['the reels tab', 'https://www.instagram.com/reels/'],
    ['a reel audio page', 'https://www.instagram.com/reels/audio/841617609931563/'],
    ['a too-short code', 'https://www.instagram.com/p/abc/'],
    ['extra path after the code', `https://www.instagram.com/p/${IG_CODE}/liked_by/`],
    ['a share kind that does not exist', 'https://www.instagram.com/share/story/BAxyz12345'],
  ])('refuses %s as link_invalid', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_invalid' });
  });

  it.each([
    ['a lookalike host', `https://instagram.com.evil.com/p/${IG_CODE}/`],
    ['a host that ends the same', `https://notinstagram.com/p/${IG_CODE}/`],
    ['a subdomain not on the list', `https://help.instagram.com/p/${IG_CODE}/`],
  ])('refuses %s as link_unsupported', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_unsupported' });
  });
});

describe('Facebook adapter: fetchPost', () => {
  it('reads a reel page: caption, subtitles, length and the video file', async () => {
    stubSite({ [FB_WATCH]: html(facebookReelPage()), [FB_SUBTITLES_URL]: html(SRT) });
    const post = await facebook.fetchPost(FB_ID);

    expect(post).toEqual({
      sourceId: FB_ID,
      sourceUrl: FB_WATCH,
      title: 'Oven kebab',
      text: FB_CAPTION,
      transcript: "You tried the viral kebab? It's a quick version to make in the oven.",
      video: { seconds: 28.5, isPublic: true, downloadUrl: FB_VIDEO_URL },
    });
    expect(requested()).toEqual([FB_WATCH, FB_SUBTITLES_URL]);
  });

  it('asks like a browser opening a link, and follows no redirect by itself', async () => {
    stubSite({ [FB_WATCH]: html(facebookReelPage({ subtitlesUrl: null })) });
    await facebook.fetchPost(FB_ID);
    const [, options] = fetch.mock.calls[0];
    expect(options.redirect).toBe('manual');
    expect(options.headers['User-Agent']).toContain('Mozilla/5.0');
    expect(options.headers['Sec-Fetch-Mode']).toBe('navigate');
  });

  it('reads the watch page a video link redirects to, with its length in milliseconds', async () => {
    const watchPage = `https://www.facebook.com/somecook/videos/${FB_ID}/`;
    stubSite({ [FB_WATCH]: redirect(watchPage), [watchPage]: html(facebookWatchPage({ seconds: 95.2 })) });
    const post = await facebook.fetchPost(FB_ID);
    expect(post).toMatchObject({ sourceId: FB_ID, text: FB_CAPTION, transcript: '', video: { seconds: 95.2, downloadUrl: FB_VIDEO_URL } });
  });

  it('picks the video by its id, not another one on the same page', async () => {
    stubSite({ [FB_WATCH]: html(facebookReelPage({ subtitlesUrl: null })) });
    const post = await facebook.fetchPost(FB_ID);
    expect(post.video.downloadUrl).toBe(FB_VIDEO_URL);
    expect(post.text).not.toContain('Another reel');
  });

  it('follows a share link to its video and answers with the real id and link', async () => {
    const share = 'https://www.facebook.com/share/r/1EQtF8caYG/';
    const reel = `https://www.facebook.com/reel/${FB_ID}/?rdid=abc&share_url=x`;
    stubSite({ [share]: redirect(reel), [reel]: html(facebookReelPage({ subtitlesUrl: null })) });
    const post = await facebook.fetchPost('share/r/1EQtF8caYG');
    expect(post).toMatchObject({ sourceId: FB_ID, sourceUrl: FB_WATCH, text: FB_CAPTION });
    expect(requested()).toEqual([share, reel]);
  });

  it('follows a fb.watch link, which starts on its own host', async () => {
    const reel = `https://www.facebook.com/watch/?v=${FB_ID}`;
    stubSite({ 'https://fb.watch/abcdef/': redirect(reel), [reel]: html(facebookWatchPage()) });
    expect(await facebook.fetchPost('fb.watch/abcdef')).toMatchObject({ sourceId: FB_ID, sourceUrl: FB_WATCH });
  });

  it('refuses a share link that leads to something that is not a video', async () => {
    const share = 'https://www.facebook.com/share/p/1AbCdEfGhI/';
    const target = 'https://www.facebook.com/somecook/posts/pfbid02abc';
    stubSite({ [share]: redirect(target), [target]: html(emptyPage()) });
    const error = await failure(facebook.fetchPost('share/p/1AbCdEfGhI'));
    expect(error).toMatchObject({ code: 'link_unsupported', retryable: false });
  });

  it('never follows a redirect off Facebook', async () => {
    stubSite({ [FB_WATCH]: redirect('https://evil.example/steal') });
    const error = await failure(facebook.fetchPost(FB_ID));
    expect(error).toMatchObject({ code: 'source_blocked', retryable: false });
    expect(requested()).toEqual([FB_WATCH]);
  });

  it.each(['http://www.facebook.com/reel/1', 'https://facebook.com.evil.com/reel/1', 'https://l.facebook.com/l.php?u=x'])(
    'never follows a redirect to %s',
    async (location) => {
      stubSite({ [FB_WATCH]: redirect(location) });
      expect(await failure(facebook.fetchPost(FB_ID))).toMatchObject({ code: 'source_blocked' });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['https://www.facebook.com/login/?next=x', 'https://www.facebook.com/login.php?next=x', '/checkpoint/block/'])(
    'says login_required for a redirect to %s, without asking for that page',
    async (location) => {
      stubSite({ [FB_WATCH]: redirect(location) });
      const error = await failure(facebook.fetchPost(FB_ID));
      expect(error).toMatchObject({ code: 'login_required', retryable: false });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('gives up on a redirect loop', async () => {
    stubSite({ 'https://www.facebook.com/': () => redirect(`https://www.facebook.com/reel/${FB_ID}/`) });
    expect(await failure(facebook.fetchPost(FB_ID))).toMatchObject({ code: 'source_blocked', retryable: false });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('says video_unavailable for a removed or private video', async () => {
    stubSite({ [FB_WATCH]: html(facebookGonePage()) });
    expect(await failure(facebook.fetchPost(FB_ID))).toMatchObject({ code: 'video_unavailable', retryable: false });
  });

  it('says video_unavailable for a 404', async () => {
    stubSite({ [FB_WATCH]: html('', 404) });
    expect(await failure(facebook.fetchPost(FB_ID))).toMatchObject({ code: 'video_unavailable', retryable: false });
  });

  it.each([400, 403, 429, 500, 503])('treats a %i as a block that may pass', async (status) => {
    stubSite({ [FB_WATCH]: html('', status) });
    const error = await failure(facebook.fetchPost(FB_ID));
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: 'source_blocked', retryable: true, detail: `www.facebook.com answered ${status}` });
  });

  it('treats a network failure as temporary', async () => {
    stubSite({ [FB_WATCH]: () => { throw new TypeError('network down'); } });
    expect(await failure(facebook.fetchPost(FB_ID))).toMatchObject({ code: 'source_blocked', retryable: true });
  });

  it('says source_blocked for a page with nothing it knows', async () => {
    stubSite({ [FB_WATCH]: html(emptyPage()) });
    expect(await failure(facebook.fetchPost(FB_ID))).toMatchObject({ code: 'source_blocked', retryable: true });
  });

  it('falls back to the link-preview text when the page came without its data', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubSite({ [FB_WATCH]: html(previewOnlyPage('39K views | &#x5e7;&#x5e8;&#x5d9;&#x5e1;&#x5e4;&#x5d9; &amp; chips | Cook', 'short')) });
    const post = await facebook.fetchPost(FB_ID);
    expect(post).toMatchObject({ sourceId: FB_ID, text: '39K views | קריספי & chips | Cook', transcript: '', video: null });
  });

  it('gives a caption-only post when the page has no video file', async () => {
    stubSite({ [FB_WATCH]: html(facebookReelPage({ videoUrl: null, subtitlesUrl: null })) });
    expect(await facebook.fetchPost(FB_ID)).toMatchObject({ text: FB_CAPTION, video: null });
  });

  it('leaves the length unknown when the page does not give one', async () => {
    stubSite({ [FB_WATCH]: html(facebookReelPage({ seconds: 0, subtitlesUrl: null })) });
    expect((await facebook.fetchPost(FB_ID)).video.seconds).toBeNull();
  });

  it('uses "Facebook" as the title of a video without a caption', async () => {
    stubSite({ [FB_WATCH]: html(facebookReelPage({ caption: '', subtitlesUrl: null })) });
    expect(await facebook.fetchPost(FB_ID)).toMatchObject({ title: 'Facebook', text: '' });
  });

  it.each([
    ['is not on the CDN', 'https://evil.example/subtitles.srt', {}],
    ['cannot be fetched', FB_SUBTITLES_URL, { [FB_SUBTITLES_URL]: html('', 403) }],
    ['fails on the network', FB_SUBTITLES_URL, { [FB_SUBTITLES_URL]: () => { throw new TypeError('down'); } }],
  ])('goes on without subtitles when their file %s', async (_, subtitlesUrl, routes) => {
    stubSite({ [FB_WATCH]: html(facebookReelPage({ subtitlesUrl })), ...routes });
    const post = await facebook.fetchPost(FB_ID);
    expect(post).toMatchObject({ transcript: '', text: FB_CAPTION });
    expect(requested()).not.toContain('https://evil.example/subtitles.srt');
  });
});

describe('Instagram adapter: fetchPost', () => {
  it('reads a reel page: caption, length and the video file', async () => {
    stubSite({ [IG_POST]: html(instagramReelPage()) });
    expect(await instagram.fetchPost(IG_CODE)).toEqual({
      sourceId: IG_CODE,
      sourceUrl: IG_POST,
      title: 'Eggplant salad',
      text: IG_CAPTION,
      transcript: '',
      video: { seconds: 37.5, isPublic: true, downloadUrl: IG_VIDEO_URL },
    });
    expect(requested()).toEqual([IG_POST]);
  });

  it.each([
    ['PT1M5.5S', 65.5],
    ['PT1H2M3S', 3723],
    ['PT0S', null],
    [null, null],
  ])('reads the length %j as %j seconds', async (duration, seconds) => {
    stubSite({ [IG_POST]: html(instagramReelPage({ duration })) });
    expect((await instagram.fetchPost(IG_CODE)).video.seconds).toBe(seconds);
  });

  it('reads a photo or carousel post as its caption, with no video', async () => {
    stubSite({ [IG_POST]: html(instagramCarouselPage()) });
    expect(await instagram.fetchPost(IG_CODE)).toMatchObject({ text: IG_CAPTION, video: null });
  });

  it('drops invisible direction marks from the title and handles a missing caption', async () => {
    stubSite({ [IG_POST]: () => html(instagramReelPage({ caption: '⁨‏  \nעוגת גבינה 🍰\nעוד שורה' })) });
    expect((await instagram.fetchPost(IG_CODE)).title).toBe('עוגת גבינה 🍰');
    stubSite({ [IG_POST]: html(instagramReelPage({ caption: null })) });
    expect(await instagram.fetchPost(IG_CODE)).toMatchObject({ title: 'Instagram', text: '' });
  });

  it('follows a share link to its post and answers with the real code and link', async () => {
    const share = 'https://www.instagram.com/share/reel/BAxyz12345/';
    const reel = `https://www.instagram.com/reel/${IG_CODE}/?igsh=abc`;
    stubSite({ [share]: redirect(reel, 301), [reel]: html(instagramReelPage()) });
    expect(await instagram.fetchPost('share/reel/BAxyz12345')).toMatchObject({ sourceId: IG_CODE, sourceUrl: IG_POST });
    expect(requested()).toEqual([share, reel]);
  });

  it('refuses a share link that leads to something that is not a post', async () => {
    const share = 'https://www.instagram.com/share/BAxyz12345/';
    stubSite({ [share]: redirect('https://www.instagram.com/somecook/'), 'https://www.instagram.com/somecook/': html(emptyPage()) });
    expect(await failure(instagram.fetchPost('share/BAxyz12345'))).toMatchObject({ code: 'link_unsupported' });
  });

  it('says login_required when redirected to the login page', async () => {
    stubSite({ [IG_POST]: redirect(`https://www.instagram.com/accounts/login/?next=%2Fp%2F${IG_CODE}%2F`) });
    expect(await failure(instagram.fetchPost(IG_CODE))).toMatchObject({ code: 'login_required', retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a post shown only after a login', instagramGatedPage],
    ['the login page itself', instagramLoginPage],
  ])('says login_required for %s', async (_, body) => {
    stubSite({ [IG_POST]: html(body()) });
    expect(await failure(instagram.fetchPost(IG_CODE))).toMatchObject({ code: 'login_required', retryable: false });
  });

  it('says video_unavailable for a removed post', async () => {
    stubSite({ [IG_POST]: html(instagramGonePage()) });
    expect(await failure(instagram.fetchPost(IG_CODE))).toMatchObject({ code: 'video_unavailable', retryable: false });
  });

  it('never follows a redirect off Instagram', async () => {
    stubSite({ [IG_POST]: redirect('https://www.facebook.com/login/') });
    expect(await failure(instagram.fetchPost(IG_CODE))).toMatchObject({ code: 'source_blocked' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('says source_blocked for a rate limit, a page with nothing it knows, or another post’s data', async () => {
    stubSite({ [IG_POST]: html('', 429) });
    expect(await failure(instagram.fetchPost(IG_CODE))).toMatchObject({ code: 'source_blocked', retryable: true });
    stubSite({ [IG_POST]: html(emptyPage()) });
    expect(await failure(instagram.fetchPost(IG_CODE))).toMatchObject({ code: 'source_blocked', retryable: true });
    stubSite({ [IG_POST]: html(instagramReelPage({ code: 'SomeOtherCode' })) });
    expect(await failure(instagram.fetchPost(IG_CODE))).toMatchObject({ code: 'source_blocked', retryable: true });
  });

  it('falls back to the link-preview text when the page came without its data', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stubSite({ [IG_POST]: html(previewOnlyPage('Cook on Instagram', 'Cook on Instagram: &quot;Eggplant salad with tahini and date syrup&quot;')) });
    const post = await instagram.fetchPost(IG_CODE);
    expect(post).toMatchObject({ text: 'Cook on Instagram: "Eggplant salad with tahini and date syrup"', video: null });
  });
});

describe('openVideo', () => {
  it('starts the download from Meta’s CDN and returns the response', async () => {
    stubSite({ [IG_VIDEO_URL]: new Response('video bytes', { headers: { 'content-type': 'video/mp4' } }) });
    const response = await openVideo({ downloadUrl: IG_VIDEO_URL });
    expect(await response.text()).toBe('video bytes');
    expect(fetch.mock.calls[0][1]).toEqual({ redirect: 'manual' });
  });

  it.each([
    'https://evil.example/video.mp4',
    'https://fbcdn.net.evil.example/video.mp4',
    'https://notfbcdn.net/video.mp4',
    'http://video.fxyz1-1.fna.fbcdn.net/video.mp4',
    'not a url',
    null,
  ])('refuses %j without any request', async (downloadUrl) => {
    stubSite({});
    const error = await failure(openVideo({ downloadUrl }));
    expect(error).toMatchObject({ code: 'video_unavailable', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [403, false],
    [404, false],
    [302, false],
    [500, true],
  ])('fails on a %i (retryable: %s)', async (status, retryable) => {
    stubSite({ [FB_VIDEO_URL]: new Response(null, { status, headers: { location: 'https://evil.example/' } }) });
    expect(await failure(openVideo({ downloadUrl: FB_VIDEO_URL }))).toMatchObject({ code: 'video_unavailable', retryable });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a network failure as temporary', async () => {
    stubSite({ [FB_VIDEO_URL]: () => { throw new TypeError('down'); } });
    expect(await failure(openVideo({ downloadUrl: FB_VIDEO_URL }))).toMatchObject({ code: 'video_unavailable', retryable: true });
  });
});

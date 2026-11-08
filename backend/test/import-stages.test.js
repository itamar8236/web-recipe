import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportError } from '../src/import/errors.js';
import { youtube } from '../src/import/sources/youtube.js';

const stubFetch = (handler) => vi.stubGlobal('fetch', vi.fn(handler));
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.unstubAllGlobals());

describe('test setup', () => {
  it('uses fake keys, so no test can reach Google with a real one', () => {
    expect(env.GEMINI_API_KEY).toBe('fake-gemini-key');
    expect(env.YOUTUBE_API_KEY).toBe('fake-youtube-key');
  });

  it('refuses every outbound request a test forgot to stub', async () => {
    const response = await fetch('https://www.googleapis.com/youtube/v3/videos');
    expect(response.status).toBe(599);
  });
});

describe('YouTube adapter: fetchMeta', () => {
  const video = {
    snippet: { title: 'Shakshuka', description: 'A long description' },
    contentDetails: { duration: 'PT2M5S' },
    status: { privacyStatus: 'public' },
  };

  it('asks the videos API for the id and returns what the stages need', async () => {
    stubFetch(async () => jsonResponse({ items: [video] }));
    const meta = await youtube.fetchMeta('dQw4w9WgXcQ', env);

    expect(meta).toEqual({
      title: 'Shakshuka',
      description: 'A long description',
      duration: 'PT2M5S',
      privacyStatus: 'public',
    });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/youtube/v3/videos');
    expect(url.searchParams.get('part')).toBe('snippet,contentDetails,status');
    expect(url.searchParams.get('id')).toBe('dQw4w9WgXcQ');
    expect(url.searchParams.get('key')).toBe('fake-youtube-key');
  });

  it('fails permanently with video_unavailable when the video does not exist', async () => {
    stubFetch(async () => jsonResponse({ items: [] }));
    const error = await youtube.fetchMeta('dQw4w9WgXcQ', env).catch((e) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: 'video_unavailable', retryable: false });
  });

  it('treats an API error as temporary', async () => {
    stubFetch(async () => jsonResponse({ error: {} }, 503));
    const error = await youtube.fetchMeta('dQw4w9WgXcQ', env).catch((e) => e);
    expect(error).toMatchObject({ code: 'llm_error', retryable: true });
  });

  it.each([[undefined], ['']])('sends nothing when the key is %j', async (key) => {
    stubFetch(async () => jsonResponse({ items: [video] }));
    const error = await youtube.fetchMeta('dQw4w9WgXcQ', { ...env, YOUTUBE_API_KEY: key }).catch((e) => e);
    expect(error).toMatchObject({ code: 'llm_error', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

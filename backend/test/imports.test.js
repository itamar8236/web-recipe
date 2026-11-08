import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { detectSource, readLink, SOURCES } from '../src/import/sources/index.js';
import { youtube } from '../src/import/sources/youtube.js';
import { insertImport, insertUser } from './helpers.js';

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe('link detection', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `http://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=30s&si=abc`,
    `https://www.youtube.com/watch?t=30s&v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/shorts/${ID}/`,
    `https://m.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://youtube.com/live/${ID}?si=xyz`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `  https://youtu.be/${ID}  `,
    `https://WWW.YOUTUBE.COM/watch?v=${ID}`,
  ])('accepts %s and stores the canonical link', (text) => {
    const link = readLink(text);
    expect(link.error).toBeUndefined();
    expect(link.source).toBe(youtube);
    expect(link.sourceId).toBe(ID);
    expect(link.sourceUrl).toBe(CANONICAL);
    expect(new URL(link.sourceUrl).hostname).toBe('www.youtube.com');
  });

  it.each([
    ['a too-short id', 'https://www.youtube.com/watch?v=short'],
    ['a too-long id', `https://www.youtube.com/watch?v=${ID}x`],
    ['bad characters in the id', 'https://www.youtube.com/watch?v=dQw4w9WgXc!'],
    ['a bad short id', 'https://youtu.be/abc'],
    ['no v parameter', 'https://www.youtube.com/watch'],
    ['a channel', 'https://www.youtube.com/@somecook'],
    ['an old channel', 'https://www.youtube.com/channel/UCabcdefghijklmnop'],
    ['a playlist', 'https://www.youtube.com/playlist?list=PL1234567890'],
    ['the home page', 'https://www.youtube.com/'],
    ['the short home page', 'https://youtu.be/'],
    ['shorts without an id', 'https://www.youtube.com/shorts/'],
    ['extra path after the id', `https://www.youtube.com/shorts/${ID}/more`],
    ['extra path on youtu.be', `https://youtu.be/${ID}/more`],
    ['text that is not a URL', 'pasta with tomatoes'],
    ['an empty string', ''],
    ['a link with no scheme', `youtube.com/watch?v=${ID}`],
    ['another scheme', `ftp://www.youtube.com/watch?v=${ID}`],
    ['javascript', 'javascript:alert(1)'],
    ['a huge input', `https://www.youtube.com/watch?v=${ID}&x=${'a'.repeat(3000)}`],
  ])('refuses %s as link_invalid', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_invalid' });
  });

  it.each([
    ['Facebook', 'https://www.facebook.com/watch/?v=1234567890'],
    ['Facebook short', 'https://fb.watch/abcdefg/'],
    ['Instagram', 'https://www.instagram.com/reel/Cabcdefghij/'],
    ['TikTok', 'https://www.tiktok.com/@cook/video/1234567890123456789'],
    ['an unknown site', 'https://example.com/recipe'],
    ['a lookalike host', `https://youtube.com.evil.example/watch?v=${ID}`],
    ['a host that ends the same', `https://notyoutube.com/watch?v=${ID}`],
    ['a subdomain not on the list', `https://music.youtube.com/watch?v=${ID}`],
    ['a user-info trick', `https://youtube.com@evil.example/watch?v=${ID}`],
  ])('refuses %s as link_unsupported', (_, text) => {
    expect(readLink(text)).toEqual({ error: 'link_unsupported' });
  });

  it('has YouTube as the only source for now, found through detectSource', () => {
    expect(SOURCES).toEqual([youtube]);
    expect(detectSource(new URL(CANONICAL))).toBe(youtube);
    expect(detectSource(new URL('https://example.com/'))).toBeUndefined();
  });
});

describe('video length', () => {
  it.each([
    ['PT3M', 180],
    ['PT12M3S', 723],
    ['PT59S', 59],
    ['PT1H2M3S', 3723],
    ['P1DT1S', 86401],
    ['P1W', 604800],
    ['P0D', 0],
  ])('reads %s as %i seconds', (duration, seconds) => {
    expect(youtube.durationSeconds(duration)).toBe(seconds);
  });

  it.each(['', '3 minutes', 'T3M'])('reads %j as unknown', (duration) => {
    expect(youtube.durationSeconds(duration)).toBeNull();
  });
});

describe('imports table rules', () => {
  it('fills in the defaults a new import needs', async () => {
    const row = await insertImport(await insertUser('dana'));
    expect(row).toMatchObject({ status: 'running', stage: 'meta', attempt: 1, state: '{}', used_best: 0, error: null });
  });

  it('allows only one running import per user and video', async () => {
    const userId = await insertUser('dana');
    await insertImport(userId);
    await expect(insertImport(userId)).rejects.toThrow(/UNIQUE/);
  });

  it('allows the same video again once the first is finished, and for another user', async () => {
    const userId = await insertUser('dana');
    await insertImport(userId, { status: 'failed' });
    await insertImport(userId);
    await insertImport(await insertUser('noa'));
  });

  it('refuses an unknown status and invalid state JSON', async () => {
    const userId = await insertUser('dana');
    await expect(insertImport(userId, { status: 'paused' })).rejects.toThrow(/CHECK/);
    await expect(insertImport(userId, { state: 'not json' })).rejects.toThrow(/CHECK/);
  });

  it('accepts any platform, so a new source needs no table change', async () => {
    const row = await insertImport(await insertUser('dana'), { platform: 'somewhere-new' });
    expect(row.platform).toBe('somewhere-new');
  });

  it('deletes a user’s imports and approval with the user', async () => {
    const userId = await insertUser('dana');
    await insertImport(userId);
    await env.DB.prepare('INSERT INTO llm_basic_model_approvals (user_id, approved_until) VALUES (?, 1)')
      .bind(userId)
      .run();
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM imports').first()).n).toBe(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM llm_basic_model_approvals').first()).n).toBe(0);
  });

  it('keeps an import when its recipe is deleted, and a re-run keeps pointing at it', async () => {
    const userId = await insertUser('dana');
    const recipe = await env.DB.prepare(
      `INSERT INTO recipes (user_id, platform, source_url, source_model, name_en) VALUES (?, 'youtube', ?, 'm', 'Tea') RETURNING id`,
    )
      .bind(userId, CANONICAL)
      .first();
    const row = await insertImport(userId, { recipe_id: recipe.id, replace_recipe_id: recipe.id });
    await env.DB.prepare('DELETE FROM recipes WHERE id = ?').bind(recipe.id).run();
    const after = await env.DB.prepare('SELECT recipe_id, replace_recipe_id FROM imports WHERE id = ?').bind(row.id).first();
    expect(after).toEqual({ recipe_id: null, replace_recipe_id: recipe.id });
  });
});

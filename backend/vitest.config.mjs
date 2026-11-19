import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside the Workers runtime against a throwaway local D1 (never production).
// The keys are fake and override any real ones in .dev.vars, and every outbound request
// is refused here, so a test that forgets a stub fails instead of spending real quota.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // An empty Groq key keeps the fallback model off, whatever .dev.vars holds. The AI
        // tools retry a busy model at once, so tests don't wait.
        bindings: { GEMINI_API_KEY: 'fake-gemini-key', YOUTUBE_API_KEY: 'fake-youtube-key', GROQ_API_KEY: '', LLM_BUSY_RETRY_MS: '0,0' },
        outboundService: () => new Response('blocked by the test setup', { status: 599 }),
      },
    }),
  ],
  test: { setupFiles: ['./test/setup.js'] },
});

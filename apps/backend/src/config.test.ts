import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('caption configuration', () => {
  it('can fetch local replay media when only the API key is configured', () => {
    const config = loadConfig({ GEMINI_API_KEY: ' test-key ' });
    expect(config.captions.geminiApiKey).toBe('test-key');
    expect(config.captions.mediaFetchBase).toBe('http://localhost:5173/media');
  });

  it('preserves explicit media origins and treats whitespace keys as disabled', () => {
    const config = loadConfig({ GEMINI_API_KEY: '  ', MEDIA_FETCH_BASE: 'http://media:8080' });
    expect(config.captions.geminiApiKey).toBeNull();
    expect(config.captions.mediaFetchBase).toBe('http://media:8080');
  });
});

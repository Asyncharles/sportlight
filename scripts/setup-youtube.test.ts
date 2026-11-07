import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { existingValue, importClient, updateEnv, validateOrigin } from './setup-youtube.mjs';

describe('YouTube setup configuration', () => {
  it('treats empty template values as empty without consuming following comments or settings', () => {
    const source = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    expect(existingValue(source, 'CONTENT_ENCRYPTION_KEY')).toBe('');
    expect(existingValue(source, 'GOOGLE_CLIENT_ID')).toBe('');
    expect(existingValue(source, 'GOOGLE_CLIENT_SECRET')).toBe('');
    expect(existingValue('CONTENT_ENCRYPTION_KEY=\nNEXT=value\n', 'CONTENT_ENCRYPTION_KEY')).toBe('');
  });
  it('preserves quoted keys and ignores inline comments', () => {
    const key = 'ab'.repeat(32);
    expect(existingValue(`CONTENT_ENCRYPTION_KEY='${key}'\n`, 'CONTENT_ENCRYPTION_KEY')).toBe(key);
    expect(existingValue(`CONTENT_ENCRYPTION_KEY=${key} # keep\n`, 'CONTENT_ENCRYPTION_KEY')).toBe(key);
  });
  it('keeps unrelated configuration and produces stable reruns', () => {
    const changes = { CONTENT_ENCRYPTION_KEY: 'ab'.repeat(32), CONTENT_APP_URL: 'http://localhost:5173' };
    const first = updateEnv('UNRELATED=keep\nCONTENT_ENCRYPTION_KEY=\n', changes);
    expect(first).toContain('UNRELATED=keep');
    expect(updateEnv(first, changes)).toBe(first);
  });
  it('rejects unsuitable origins and credentials from another project', () => {
    expect(() => validateOrigin('http://example.com')).toThrow();
    expect(() => importClient({ web: { client_id: 'id', client_secret: 'secret', project_id: 'other' } }, 'sportlight-514020', 'http://localhost:5173')).toThrow();
  });
});

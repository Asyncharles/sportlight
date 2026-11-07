import { describe, expect, it } from 'vitest';
import type { FeedState } from '@sportlight/shared';
import { resolveVoiceCommand } from '../apps/web/src/features/live/voiceCommands';
const feed = (id: string, title: string, sportId: string, status = 'live') =>
  ({ id, event: { title }, sportId, status }) as FeedState;
const tennis = feed('a', 'France v Germany', 'tennis');
const football = feed('b', 'Arsenal v Chelsea', 'football');
const feeds = [tennis, football];
const resolve = (text: string) => resolveVoiceCommand(text, feeds, [tennis, football], tennis.id);
describe('voice feed commands', () => {
  it('understands TV navigation and wraps around', () => {
    for (const text of ['next feed', 'switch to the next feed', 'channel up', 'previous channel']) {
      expect(resolve(text)).toEqual({ type: 'feed', feed: football });
    }
    expect(resolveVoiceCommand('next feed', feeds, feeds, football.id)).toEqual({ type: 'feed', feed: tennis });
  });
  it('matches a sport, team or numbered screen', () => {
    for (const text of ['please show me football', 'watch Arsenal', 'switch to screen two', 'window 2']) {
      expect(resolve(text)).toEqual({ type: 'feed', feed: football });
    }
  });
  it('rejects ambiguity, unavailable feeds, unknown commands and empty screens', () => {
    expect(resolveVoiceCommand('tennis', [tennis, feed('c', 'Spain v Italy', 'tennis')], [])).toMatchObject({
      type: 'message',
    });
    expect(resolveVoiceCommand('football', [feed('b', 'Arsenal', 'football', 'ended')], [])).toMatchObject({
      type: 'message',
    });
    expect(resolve('screen four')).toMatchObject({ type: 'message' });
    expect(resolve('do something')).toMatchObject({ type: 'message' });
  });
  it('distinguishes mute from unmute', () => {
    expect(resolve('mute')).toEqual({ type: 'audio', enabled: false });
    expect(resolve('unmute')).toEqual({ type: 'audio', enabled: true });
  });
});

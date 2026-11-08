import { describe, expect, it } from 'vitest';
import type { FeedState } from '@sportlight/shared';
import { resolveVoiceCommand } from '../apps/web/src/features/live/voiceCommands';
const feed = (id: string, title: string, sportId: string, status = 'live') =>
  ({ id, event: { title }, sportId, status }) as FeedState;
const tennis = feed('a', 'France v Germany', 'tennis');
const football = feed('b', 'Arsenal v Chelsea', 'football');
const feeds = [tennis, football];
const resolve = (text: string) => resolveVoiceCommand(text, feeds, [tennis, football], tennis.id).command;
describe('voice feed commands', () => {
  it('understands TV navigation and wraps around', () => {
    for (const text of ['next feed', 'switch to the next feed', 'channel up', 'previous channel']) {
      expect(resolve(text)).toEqual({ type: 'feed', feed: football });
    }
    expect(resolveVoiceCommand('next feed', feeds, feeds, football.id).command).toEqual({ type: 'feed', feed: tennis });
  });
  it('matches a sport, team or numbered screen', () => {
    for (const text of ['please show me football', 'watch Arsenal', 'switch to screen two', 'window 2']) {
      expect(resolve(text)).toEqual({ type: 'feed', feed: football });
    }
  });
  it('rejects ambiguity, unavailable feeds, unknown commands and empty screens', () => {
    expect(resolveVoiceCommand('tennis', [tennis, feed('c', 'Spain v Italy', 'tennis')], []).command).toMatchObject({
      type: 'message',
    });
    expect(resolveVoiceCommand('football', [feed('b', 'Arsenal', 'football', 'ended')], []).command).toMatchObject({
      type: 'message',
    });
    expect(resolve('screen four')).toMatchObject({ type: 'message' });
    expect(resolve('do something')).toMatchObject({ type: 'message' });
  });
  it('distinguishes mute from unmute', () => {
    expect(resolve('mute')).toEqual({ type: 'audio', enabled: false });
    expect(resolve('unmute')).toEqual({ type: 'audio', enabled: true });
  });
  it('autocorrects misheard words and finds commands in longer sentences', () => {
    expect(resolve('scream two')).toEqual({ type: 'feed', feed: football });
    expect(resolve('next feet')).toEqual({ type: 'feed', feed: football });
    expect(resolve('can you please put screen to on for me')).toEqual({ type: 'feed', feed: football });
    expect(resolve('I want to watch the Arsenal game please')).toEqual({ type: 'feed', feed: football });
    expect(resolve('show me the dennis')).toEqual({ type: 'feed', feed: tennis });
    expect(resolve('could you mute the sound please')).toEqual({ type: 'audio', enabled: false });
    expect(resolve('turn the sound back on')).toEqual({ type: 'audio', enabled: true });
  });
});

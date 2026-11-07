import type { FeedState } from '@sportlight/shared';

export type VoiceCommand =
  { type: 'feed'; feed: FeedState } | { type: 'audio'; enabled: boolean } | { type: 'message'; message: string };

/** A resolved command plus the cleaned-up text it was resolved from (shown when autocorrect changed it). */
export interface VoiceResult {
  command: VoiceCommand;
  heard: string;
  understood: string;
  /** True when autocorrect changed any word. */
  corrected: boolean;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])(\d)|(\d)([a-z])/g, '$1$3 $2$4')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Words speech engines commonly mishear for our command vocabulary. */
const MISHEARD: Record<string, string> = {
  scream: 'screen',
  screams: 'screen',
  screens: 'screen',
  screening: 'screen',
  scrin: 'screen',
  skrin: 'screen',
  windows: 'window',
  feet: 'feed',
  feat: 'feed',
  fee: 'feed',
  food: 'feed',
  feeds: 'feed',
  neck: 'next',
  necks: 'next',
  nex: 'next',
  moot: 'mute',
  mewt: 'mute',
  newt: 'mute',
  mutes: 'mute',
  muted: 'mute',
  unmuted: 'unmute',
  previews: 'previous',
};

/** Number words, including homophones, used after "screen"/"window". */
const NUMBERS: Record<string, number> = {
  one: 1, won: 1, wan: 1, '1': 1, first: 1,
  two: 2, to: 2, too: 2, tu: 2, '2': 2, second: 2,
  three: 3, free: 3, tree: 3, '3': 3, third: 3,
  four: 4, for: 4, fore: 4, floor: 4, '4': 4, fourth: 4, forth: 4,
};
const NUMBER_WORDS = ['one', 'two', 'three', 'four'];
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 };

const COMMAND_WORDS = [
  'screen', 'window', 'next', 'previous', 'last', 'channel', 'mute', 'unmute', 'sound', 'volume',
  'audio', 'feed', 'switch', 'show', 'watch', 'change', 'skip', 'back', 'silence', 'quiet',
];

/** Filler that carries no meaning for matching a feed. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'on', 'in', 'at', 'to', 'for', 'me', 'my', 'i', 'you', 'we', 'it', 'is',
  'can', 'could', 'would', 'will', 'please', 'want', 'like', 'lets', 'let', 'us', 'now', 'just', 'go', 'get',
  'put', 'show', 'watch', 'switch', 'change', 'over', 'turn', 'see', 'some', 'that', 'this', 'there', 'hey',
  'ok', 'okay', 'um', 'uh', 'er', 'so', 'then', 'thanks', 'thank', 'feed', 'game', 'match', 'channel',
  'stream', 'play', 'open', 'bring', 'up', 'give', 'need', 'id', 'love', 'do', 'have', 'v', 'vs', 'versus',
  'screen', 'window', 'live', 'with', 'from', 'what', 'about', 'how', 'instead', 'onto', 'into', 'down',
]);

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** Snap a word to the closest known word when the recogniser was close but wrong. */
function closest(word: string, vocab: ReadonlySet<string>): string {
  if (vocab.has(word) || word.length < 4 || /\d/.test(word)) return word;
  let best = word;
  let bestDistance = 3;
  for (const candidate of vocab) {
    if (candidate.length < 4) continue;
    const d = distance(word, candidate);
    const allowed = word.length >= 5 && candidate[0] === word[0] ? 2 : 1;
    if (d <= allowed && d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

const feedWords = (f: FeedState) =>
  new Set(
    [f.event.title, f.sportId, f.event.subtitle, f.event.broadcaster?.channel, ...(f.event.teamIds ?? [])]
      .filter((v): v is string => !!v)
      .flatMap((v) => normalize(v).split(' '))
      .filter((w) => w && !STOPWORDS.has(w)),
  );

/** Resolve only against currently available feeds; never guess between equally good matches. */
export function resolveVoiceCommand(
  transcript: string,
  feeds: readonly FeedState[],
  screens: readonly (FeedState | null)[],
  currentId?: string,
): VoiceResult {
  const available = feeds
    .filter((f) => f.status === 'live')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const vocabs = new Map(available.map((f) => [f, feedWords(f)]));
  const feedVocab = new Set([...vocabs.values()].flatMap((s) => [...s]));
  const vocab = new Set([...COMMAND_WORDS, ...STOPWORDS, ...feedVocab, ...Object.keys(NUMBERS)]);

  const raw = normalize(transcript)
    .replace(/\bun mute\b/g, 'unmute')
    .replace(/^on mute$/, 'unmute');
  const words = raw
    .split(' ')
    .filter(Boolean)
    .map((w) => (feedVocab.has(w) ? w : (MISHEARD[w] ?? closest(w, vocab))));
  const text = ` ${words.join(' ')} `;
  const corrected = words.join(' ') !== raw.split(' ').filter(Boolean).join(' ');
  const result = (command: VoiceCommand): VoiceResult => ({ command, heard: transcript, understood: text.trim(), corrected });
  const message = (m: string) => result({ type: 'message', message: m });
  const has = (re: RegExp) => re.test(text);

  // Audio — check "unmute"/"sound on" before "mute"/"sound off".
  if (has(/ (unmute|(sound|audio|volume) (back )?on|turn on (the )?(sound|audio|volume)) /))
    return result({ type: 'audio', enabled: true });
  if (has(/ (mute|silence|quiet|(sound|audio|volume) off|turn off (the )?(sound|audio|volume)) /))
    return result({ type: 'audio', enabled: false });

  if (!available.length) return message('No live feeds are available yet.');

  // Screens: "screen two", "window 3", "the second screen", "main screen".
  const screenAt = words.findIndex((w) => w === 'screen' || w === 'window');
  if (screenAt >= 0) {
    const n = NUMBERS[words[screenAt + 1] ?? ''] ??
      (words[screenAt + 1] === 'number' ? NUMBERS[words[screenAt + 2] ?? ''] : undefined) ??
      ORDINALS[words[screenAt - 1] ?? ''];
    if (n) {
      const feed = screens[n - 1];
      return feed?.status === 'live'
        ? result({ type: 'feed', feed })
        : message(`Screen ${NUMBER_WORDS[n - 1]} has no live feed.`);
    }
  }

  // Feed matching by sport, team or event words — the best-scoring single feed wins.
  const content = words.filter((w) => !STOPWORDS.has(w) && !COMMAND_WORDS.includes(w));
  if (content.length) {
    const scored = available
      .map((feed) => ({ feed, score: content.filter((w) => vocabs.get(feed)!.has(w)).length }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 1 || (scored.length > 1 && scored[0]!.score > scored[1]!.score))
      return result({ type: 'feed', feed: scored[0]!.feed });
    if (scored.length > 1) {
      const tied = scored.filter((s) => s.score === scored[0]!.score);
      return message(
        `Several feeds match. Try an event name: ${tied
          .slice(0, 3)
          .map((s) => s.feed.event.title)
          .join('; ')}.`,
      );
    }
  }

  // Next / previous.
  const backwards = has(/ (previous|last|back|channel down) /);
  if (backwards || has(/ (next|skip|channel up|another) /)) {
    const index = available.findIndex((f) => f.id === currentId);
    const feed = available[index < 0 ? 0 : (index + (backwards ? -1 : 1) + available.length) % available.length]!;
    return result({ type: 'feed', feed });
  }

  if (!words.length) return message('Say a sport, team or event name.');
  return message('Didn’t catch a command or live feed.');
}

/** Try each of the recogniser's alternative transcripts and keep the first that does something. */
export function resolveVoiceAlternatives(
  transcripts: readonly string[],
  feeds: readonly FeedState[],
  screens: readonly (FeedState | null)[],
  currentId?: string,
): VoiceResult {
  const results = (transcripts.length ? transcripts : ['']).map((t) =>
    resolveVoiceCommand(t, feeds, screens, currentId),
  );
  return results.find((r) => r.command.type !== 'message') ?? results[0]!;
}

/** Example phrases for the mic hint, using a live feed's name where possible. */
export function voiceExamples(feeds: readonly FeedState[]): string[] {
  const live = feeds.find((f) => f.status === 'live');
  const sport = live?.sportId.replace(/[-_]/g, ' ');
  return ['Next feed', 'Screen two', sport ? `Show me ${sport}` : 'Show me tennis', 'Mute / unmute'];
}

import type { Competition, EventInfo, FeedState, Follow, Sport, SportId, Team } from './domain.js';

/** Hardcoded prototype catalogue. A real deployment would serve this from a catalogue service. */
export const SPORTS: readonly Sport[] = [
  { id: 'football', name: 'Football', icon: 'goal' },
  { id: 'basketball', name: 'Basketball', icon: 'volleyball' },
  { id: 'tennis', name: 'Tennis', icon: 'ball-wave' },
  { id: 'motorsport', name: 'Motorsport', icon: 'flag' },
  { id: 'ice-hockey', name: 'Ice hockey', icon: 'hockey-stick' },
  { id: 'cycling', name: 'Cycling', icon: 'bike' },
  { id: 'rugby', name: 'Rugby', icon: 'rugby-ball' },
  { id: 'athletics', name: 'Athletics', icon: 'footprints' },
  { id: 'chess', name: 'Chess', icon: 'chess-knight' },
  { id: 'esports', name: 'Esports', icon: 'gamepad-2' },
  { id: 'weightlifting', name: 'Weightlifting', icon: 'dumbbell' },
];

export const COMPETITIONS: readonly Competition[] = [
  { id: 'uefa-nations-league', sportId: 'football', name: 'Nations League' },
  { id: 'ncaa-basketball', sportId: 'basketball', name: 'NCAA Basketball' },
  { id: 'davis-cup', sportId: 'tennis', name: 'Davis Cup' },
  { id: 'formula-1', sportId: 'motorsport', name: 'Formula 1' },
  { id: 'formula-07', sportId: 'motorsport', name: 'Fórmula 07' },
  { id: 'ncaa-hockey', sportId: 'ice-hockey', name: 'NCAA Women’s Hockey' },
  { id: 'gp-zottegem', sportId: 'cycling', name: 'GP Stad Zottegem' },
  { id: 'rugby-internationals', sportId: 'rugby', name: 'Rugby Internationals' },
  { id: 'diamond-league', sportId: 'athletics', name: 'Diamond League' },
  { id: 'blitz-open', sportId: 'chess', name: 'Blitz Open' },
  { id: 'allied-esports', sportId: 'esports', name: 'Tournament of Champions' },
  { id: 'nba', sportId: 'basketball', name: 'NBA' },
  { id: 'fifa-world-cup', sportId: 'football', name: 'FIFA World Cup' },
  { id: 'iwf-worlds', sportId: 'weightlifting', name: 'World Weightlifting Championships' },
];

export const TEAMS: readonly Team[] = [
  { id: 'fra', sportId: 'football', name: 'France', shortName: 'FRA' },
  { id: 'ger', sportId: 'football', name: 'Germany', shortName: 'GER' },
  { id: 'uru', sportId: 'tennis', name: 'Uruguay', shortName: 'URU' },
  { id: 'mex', sportId: 'tennis', name: 'Mexico', shortName: 'MEX' },
];

const sportsById = new Map(SPORTS.map((s) => [s.id, s]));
const competitionsById = new Map(COMPETITIONS.map((c) => [c.id, c]));

export function getSport(id: SportId): Sport | undefined {
  return sportsById.get(id);
}

export function getCompetition(id: string | undefined): Competition | undefined {
  return id ? competitionsById.get(id) : undefined;
}

export function isKnownSport(id: string): boolean {
  return sportsById.has(id);
}

/** Does a feed match any of the viewer's follows? An empty follow list matches nothing. */
export function matchesFollows(feed: Pick<FeedState, 'sportId' | 'event'>, follows: readonly Follow[]): boolean {
  return follows.some((f) => followMatches(f, feed.sportId, feed.event));
}

export function followMatches(follow: Follow, sportId: SportId, event: EventInfo): boolean {
  switch (follow.kind) {
    case 'sport':
      return follow.id === sportId;
    case 'competition':
      return follow.id === event.competitionId;
    case 'team':
      return event.teamIds?.includes(follow.id) ?? false;
  }
}

export function sportFollows(sportIds: readonly SportId[]): Follow[] {
  return sportIds.map((id) => ({ kind: 'sport', id }));
}

export function followedSportIds(follows: readonly Follow[]): SportId[] {
  return follows.filter((f) => f.kind === 'sport').map((f) => f.id);
}

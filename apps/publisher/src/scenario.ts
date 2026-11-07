/**
 * The repeatable demo scenario.
 *
 * Time is "scenario time" in seconds since the publisher started (optionally offset). The schedule
 * repeats every `CYCLE_SEC`; within a cycle each feed has live windows, optional outage windows and
 * authored peaks. A seeded, smooth noise term keeps the numbers alive between peaks. Everything is a
 * pure function of (seed, time), so the same seed always replays the same session.
 *
 * Authored beats that exercise the client selection rules (with default config):
 *   ~35 s  Ice hockey surges for ~25 s — a hidden feed overtaking a side feed after its 20 s dwell.
 *   ~70 s  Chess spikes for ~2 s only — must NOT trigger a replacement (3 s rule).
 *   100 s  Athletics starts hot — a new feed arriving mid-session.
 *   210 s  Tennis ends — a visible feed ending must be replaced immediately; it restarts at 300 s.
 *   240 s  Motorsport (F1) drops out for ~22 s — unavailable feeds leave the layout immediately.
 *   600 s  Basketball ends; 780–900 s cycling ends with a final sprint peak.
 */

export const CYCLE_SEC = 900;

export interface Peak {
  /** Cycle time at which the rise begins. */
  at: number;
  /** Height added on top of the baseline. */
  height: number;
  rise?: number;
  hold?: number;
  fall?: number;
}

export interface DemoFeed {
  id: string;
  sportId: string;
  clipId: string;
  title: string;
  subtitle: string;
  competitionId?: string;
  teamIds?: string[];
  venue?: string;
  /** Mock rights-holder metadata, as a real provider feed would carry it. */
  broadcaster: { name: string; channel?: string };
  /** [start, end) cycle-time windows during which the feed is live. */
  live: Array<[number, number]>;
  /** [start, end) cycle-time windows during which the provider reports the feed unavailable. */
  outages?: Array<[number, number]>;
  baseline: number;
  /** Amplitude of the slow noise term. */
  volatility: number;
  peaks: Peak[];
}

export const DEMO_FEEDS: DemoFeed[] = [
  {
    id: 'fra-ger',
    sportId: 'football',
    clipId: 'football-fra-ger',
    title: 'France v Germany',
    subtitle: 'Nations League · Stade de France',
    competitionId: 'uefa-nations-league',
    teamIds: ['fra', 'ger'],
    broadcaster: { name: 'Sky Sports', channel: 'Sky Sports Football' },
    venue: 'Stade de France',
    live: [[0, CYCLE_SEC]],
    baseline: 58,
    volatility: 6,
    peaks: [
      { at: 95, height: 34, hold: 14 },
      { at: 400, height: 38, hold: 10 },
      { at: 705, height: 30, hold: 18 },
    ],
  },
  {
    id: 'hawaii-nau',
    sportId: 'basketball',
    clipId: 'basketball-hawaii',
    title: 'Hawaiʻi v Northern Arizona',
    subtitle: 'NCAA Basketball · Stan Sheriff Center',
    competitionId: 'ncaa-basketball',
    broadcaster: { name: 'ESPN', channel: 'ESPN2' },
    venue: 'Stan Sheriff Center',
    live: [[0, 600]],
    baseline: 52,
    volatility: 7,
    peaks: [
      { at: 58, height: 30, hold: 10 },
      { at: 250, height: 42, hold: 12 },
      { at: 480, height: 34, hold: 8 },
    ],
  },
  {
    id: 'uru-mex',
    sportId: 'tennis',
    clipId: 'tennis-davis-cup',
    title: 'Uruguay v Mexico',
    subtitle: 'Davis Cup · Americas Zone',
    competitionId: 'davis-cup',
    teamIds: ['uru', 'mex'],
    broadcaster: { name: 'Eurosport', channel: 'Eurosport 1' },
    live: [
      [0, 210],
      [300, CYCLE_SEC],
    ],
    baseline: 46,
    volatility: 6,
    peaks: [
      { at: 140, height: 36, hold: 9 },
      { at: 360, height: 30, hold: 12 },
      { at: 620, height: 45, hold: 10 },
    ],
  },
  {
    id: 'turkish-gp',
    sportId: 'motorsport',
    clipId: 'motorsport-turkish-gp',
    title: 'Turkish Grand Prix',
    subtitle: 'Formula 1 · Istanbul Park',
    competitionId: 'formula-1',
    broadcaster: { name: 'Sky Sports', channel: 'Sky Sports F1' },
    venue: 'Istanbul Park',
    live: [[0, CYCLE_SEC]],
    outages: [[240, 262]],
    baseline: 56,
    volatility: 5,
    peaks: [
      { at: 160, height: 38, hold: 20 },
      { at: 560, height: 36, hold: 10 },
      { at: 820, height: 28, hold: 14 },
    ],
  },
  {
    id: 'formula07',
    sportId: 'motorsport',
    clipId: 'motorsport-formula07',
    title: 'Fórmula 07 · Round 5',
    subtitle: 'Class B race · Autódromo Gálvez',
    competitionId: 'formula-07',
    broadcaster: { name: 'Motorsport.tv', channel: 'Motorsport.tv Live' },
    venue: 'Autódromo Gálvez',
    live: [[420, CYCLE_SEC]],
    baseline: 47,
    volatility: 8,
    peaks: [
      { at: 470, height: 40, hold: 8 },
      { at: 760, height: 34, hold: 12 },
    ],
  },
  {
    id: 'rpi-syracuse',
    sportId: 'ice-hockey',
    clipId: 'icehockey-rpi',
    title: 'Syracuse v RPI',
    subtitle: 'NCAA Women’s Hockey · Tennity Pavilion',
    competitionId: 'ncaa-hockey',
    broadcaster: { name: 'ESPN', channel: 'ESPN+' },
    venue: 'Tennity Pavilion',
    live: [[0, CYCLE_SEC]],
    baseline: 38,
    volatility: 6,
    peaks: [
      { at: 33, height: 52, rise: 4, hold: 24 },
      { at: 330, height: 40, hold: 10 },
      { at: 640, height: 48, hold: 9 },
    ],
  },
  {
    id: 'zottegem',
    sportId: 'cycling',
    clipId: 'cycling-zottegem',
    title: 'Grote Prijs Stad Zottegem',
    subtitle: 'UCI Europe Tour · Final laps',
    competitionId: 'gp-zottegem',
    broadcaster: { name: 'Eurosport', channel: 'Eurosport 2' },
    venue: 'Zottegem',
    live: [[120, 780]],
    baseline: 40,
    volatility: 5,
    peaks: [
      { at: 300, height: 30, hold: 15 },
      { at: 740, height: 52, rise: 10, hold: 22 },
    ],
  },
  {
    id: 'rugby-intl',
    sportId: 'rugby',
    clipId: 'rugby-mixed',
    title: 'Rugby Internationals',
    subtitle: 'Test series · Live from the pitch',
    competitionId: 'rugby-internationals',
    broadcaster: { name: 'TNT Sports', channel: 'TNT Sports 1' },
    live: [[60, 840]],
    baseline: 48,
    volatility: 7,
    peaks: [
      { at: 190, height: 36, hold: 10 },
      { at: 455, height: 42, hold: 8 },
      { at: 690, height: 32, hold: 12 },
    ],
  },
  {
    id: 'blitz-open',
    sportId: 'chess',
    clipId: 'chess-blitz',
    title: 'Blitz Open · Board 1',
    subtitle: '3+2 · Final round',
    competitionId: 'blitz-open',
    broadcaster: { name: 'Chess24', channel: 'Chess24 Live' },
    live: [[0, CYCLE_SEC]],
    baseline: 28,
    volatility: 4,
    peaks: [
      { at: 70, height: 66, rise: 0.5, hold: 1.2, fall: 0.5 },
      { at: 520, height: 58, hold: 10 },
    ],
  },
  {
    id: 'yokota-esports',
    sportId: 'esports',
    clipId: 'esports-yokota',
    title: 'Tournament of Champions',
    subtitle: 'Grand final · Yokota',
    competitionId: 'allied-esports',
    broadcaster: { name: 'Twitch', channel: 'Allied Esports' },
    venue: 'Yokota',
    live: [[0, CYCLE_SEC]],
    baseline: 50,
    volatility: 8,
    peaks: [
      { at: 210, height: 34, hold: 12 },
      { at: 590, height: 40, hold: 9 },
    ],
  },
  {
    id: 'relay-final',
    sportId: 'athletics',
    clipId: 'athletics-relay',
    title: 'Women’s 4×100 m',
    subtitle: 'Diamond League · Lausanne',
    competitionId: 'diamond-league',
    broadcaster: { name: 'BBC Sport', channel: 'BBC Two' },
    venue: 'Stade Olympique de la Pontaise',
    live: [[100, 400]],
    baseline: 45,
    volatility: 5,
    peaks: [
      { at: 100, height: 42, rise: 3, hold: 16 },
      { at: 330, height: 46, hold: 8 },
    ],
  },
  {
    id: 'football-france-croatia-2018',
    sportId: 'football',
    clipId: 'football-france-croatia-2018',
    title: 'France v Croatia',
    subtitle: '2018 FIFA World Cup · Final',
    broadcaster: { name: 'FIFA', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 44,
    volatility: 6,
    peaks: [
      { at: 110, height: 38, hold: 16 },
      { at: 510, height: 40, hold: 12 },
    ],
  },
  {
    id: 'basketball-argentina-spain-2019',
    sportId: 'basketball',
    clipId: 'basketball-argentina-spain-2019',
    title: 'Argentina v Spain',
    subtitle: '2019 FIBA World Cup · Final',
    broadcaster: { name: 'FIBA Basketball', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 47,
    volatility: 6,
    peaks: [
      { at: 190, height: 38, hold: 16 },
      { at: 585, height: 40, hold: 12 },
    ],
  },
  {
    id: 'rugby-newzealand-australia-2015',
    sportId: 'rugby',
    clipId: 'rugby-newzealand-australia-2015',
    title: 'New Zealand v Australia',
    subtitle: '2015 Rugby World Cup · Final',
    broadcaster: { name: 'World Rugby', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 50,
    volatility: 6,
    peaks: [
      { at: 270, height: 38, hold: 16 },
      { at: 660, height: 40, hold: 12 },
    ],
  },
  {
    id: 'tennis-murray-djokovic-2013',
    sportId: 'tennis',
    clipId: 'tennis-murray-djokovic-2013',
    title: 'Murray v Djokovic',
    subtitle: 'Wimbledon 2013 · Final',
    broadcaster: { name: 'Wimbledon', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 38,
    volatility: 6,
    peaks: [
      { at: 45, height: 42, hold: 16 },
      { at: 440, height: 38, hold: 12 },
    ],
  },
  {
    id: 'motorsport-london-2023',
    sportId: 'motorsport',
    clipId: 'motorsport-london-2023',
    title: 'London E-Prix',
    subtitle: 'Formula E 2023 · Round 15',
    broadcaster: { name: 'Channel 4 Sport', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 42,
    volatility: 6,
    peaks: [
      { at: 85, height: 42, hold: 16 },
      { at: 485, height: 38, hold: 12 },
    ],
  },
  {
    id: 'cycling-nove-mesto-u23',
    sportId: 'cycling',
    clipId: 'cycling-nove-mesto-u23',
    title: 'Men’s U23 XCO · Nové Město',
    subtitle: 'UCI Mountain Bike World Series · Full race',
    broadcaster: { name: 'WHOOP UCI Mountain Bike World Series', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 46,
    volatility: 6,
    peaks: [
      { at: 125, height: 42, hold: 16 },
      { at: 530, height: 38, hold: 12 },
    ],
  },
  {
    id: 'esports-t1-blg-2024',
    sportId: 'esports',
    clipId: 'esports-t1-blg-2024',
    title: 'T1 v Bilibili Gaming',
    subtitle: 'Worlds 2024 · Grand Final · Game 5',
    broadcaster: { name: 'EpicSkillshot - LoL VOD Library', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 50,
    volatility: 6,
    peaks: [
      { at: 165, height: 42, hold: 16 },
      { at: 575, height: 38, hold: 12 },
    ],
  },
  {
    id: 'chess-clutch-2025',
    sportId: 'chess',
    clipId: 'chess-clutch-2025',
    title: 'Clutch Chess · Champions Showdown',
    subtitle: '2025 · Final day',
    broadcaster: { name: 'Saint Louis Chess Club', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 54,
    volatility: 6,
    peaks: [
      { at: 205, height: 42, hold: 16 },
      { at: 620, height: 38, hold: 12 },
    ],
  },
  {
    id: 'athletics-budapest-day2',
    sportId: 'athletics',
    clipId: 'athletics-budapest-day2',
    title: 'World Athletics · Day 2',
    subtitle: '2026 Ultimate Championship · Budapest',
    broadcaster: { name: 'World Athletics', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 38,
    volatility: 6,
    peaks: [
      { at: 245, height: 42, hold: 16 },
      { at: 665, height: 38, hold: 12 },
    ],
  },
  {
    id: 'basketball-germany-serbia-2023',
    sportId: 'basketball',
    clipId: 'basketball-germany-serbia-2023',
    title: 'Germany v Serbia',
    subtitle: '2023 FIBA World Cup · Final',
    broadcaster: { name: 'FIBA Basketball', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 42,
    volatility: 6,
    peaks: [
      { at: 285, height: 42, hold: 16 },
      { at: 710, height: 38, hold: 12 },
    ],
  },
  {
    id: 'rugby-england-australia-2003',
    sportId: 'rugby',
    clipId: 'rugby-england-australia-2003',
    title: 'England v Australia',
    subtitle: '2003 Rugby World Cup · Final',
    broadcaster: { name: 'World Rugby', channel: 'YouTube replay' },
    live: [[0, CYCLE_SEC]],
    baseline: 46,
    volatility: 6,
    peaks: [
      { at: 325, height: 42, hold: 16 },
      { at: 755, height: 38, hold: 12 },
    ],
  },
];

// ---------------------------------------------------------------- deterministic maths

/** Small, fast seeded hash → [0, 1). */
export function hash01(seed: number, ...xs: number[]): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const x of xs) {
    h = Math.imul(h ^ Math.floor(x), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
  }
  return (h >>> 0) / 4294967296;
}

export function stringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const smoothstep = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Smooth 1-D value noise in [-1, 1] with features roughly `period` seconds apart. */
function valueNoise(seed: number, t: number, period: number): number {
  const x = t / period;
  const i = Math.floor(x);
  const a = hash01(seed, i) * 2 - 1;
  const b = hash01(seed, i + 1) * 2 - 1;
  return a + (b - a) * smoothstep(x - i);
}

export function peakShape(p: Peak, cycleT: number): number {
  const rise = p.rise ?? 5;
  const hold = p.hold ?? 8;
  const fall = p.fall ?? 7;
  const t = cycleT - p.at;
  if (t < 0 || t > rise + hold + fall) return 0;
  if (t < rise) return smoothstep(t / rise);
  if (t < rise + hold) return 1;
  return 1 - smoothstep((t - rise - hold) / fall);
}

/** Intensity (0–100, integer) of `feed` at absolute scenario time `t`. */
export function intensityAt(feed: DemoFeed, t: number, seed: number): number {
  const cycleT = ((t % CYCLE_SEC) + CYCLE_SEC) % CYCLE_SEC;
  const s = seed ^ stringSeed(feed.id);
  const slow = valueNoise(s, t, 9) * feed.volatility;
  const fast = valueNoise(s + 1, t, 2.5) * feed.volatility * 0.35;
  const peaks = feed.peaks.reduce((sum, p) => sum + p.height * peakShape(p, cycleT), 0);
  return Math.round(Math.min(100, Math.max(0, feed.baseline + slow + fast + peaks)));
}

export function inWindows(windows: Array<[number, number]> | undefined, t: number): boolean {
  const cycleT = ((t % CYCLE_SEC) + CYCLE_SEC) % CYCLE_SEC;
  return (windows ?? []).some(([a, b]) => cycleT >= a && cycleT < b);
}

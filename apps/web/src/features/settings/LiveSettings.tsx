import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Play } from 'lucide-react';
import type { FeedState } from '@sportlight/shared';
import { LogoMark } from '../../components/Logo';
import { mediaUrl } from '../../lib/env';
import { useReducedMotion } from '../../lib/hooks';
import { useLive } from '../../lib/live-client';
import {
  ANIMATIONS,
  LAYOUTS,
  PACES,
  effectiveSelectionConfig,
  layoutDef,
  revealMsFor,
} from '../../lib/live-ui';
import {
  DEFAULT_LIVE_PREFERENCES,
  usePreferences,
  type LayoutId,
  type SwitchAnimation,
} from '../../lib/preferences';
import { Row, Segmented } from './controls';
import styles from './LiveSettings.module.scss';
import base from './Settings.module.scss';

/** Live view settings: layout, switching rules and switch animation. */
export function LiveSettings() {
  const { prefs, updateLive } = usePreferences();
  const live = prefs.live;
  const { config, feeds } = useLive();
  const effective = effectiveSelectionConfig(config?.selection, live);
  const posters = useMemo(
    () =>
      Object.values(feeds)
        .filter((f: FeedState) => f.source.posterUrl)
        .slice(0, 6)
        .map((f) => mediaUrl(f.source.posterUrl)!),
    [feeds],
  );

  return (
    <>
      <section className={base.section} aria-labelledby="experiments">
        <h2 id="experiments" className={base.heading}>Experiments</h2>
        <Row label="3D viewing room" hint="Step into a panoramic room of live screens. Drag to look around, scroll to move closer, or choose a screen to watch.">
          <button type="button" role="switch" aria-checked={live.beta3d}
            aria-label="3D viewing room" className="sl-button small secondary"
            onClick={() => updateLive({ beta3d: !live.beta3d })}>
            {live.beta3d ? 'Enabled' : 'Disabled'}
          </button>
        </Row>
      </section>
      <section className={base.section} aria-labelledby="layout">
        <h2 id="layout" className={base.heading}>
          Layout
        </h2>
        <div className={styles.layouts} role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={live.layout === l.id}
              className={`${styles.layoutCard} ${live.layout === l.id ? styles.on : ''}`}
              onClick={() => updateLive({ layout: l.id })}
            >
              <LayoutDiagram id={l.id} side={live.sidebar} />
              <span className={styles.cardName}>{l.name}</span>
              <span className={styles.cardHint}>{l.description}</span>
            </button>
          ))}
        </div>
        <Row label="Sidebar" hint={layoutDef(live.layout).sided ? 'Which side the smaller windows sit on.' : 'Not used by this layout.'}>
          <Segmented<'left' | 'right'>
            label="Sidebar position"
            value={live.sidebar}
            onChange={(sidebar) => updateLive({ sidebar })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'right', label: 'Right' },
            ]}
          />
        </Row>
      </section>

      <section className={base.section} aria-labelledby="switching">
        <div className={base.sectionHead}>
          <h2 id="switching" className={base.heading}>
            Switching
          </h2>
          <button
            type="button"
            className={styles.reset}
            onClick={() =>
              updateLive({
                pace: DEFAULT_LIVE_PREFERENCES.pace,
                mainPolicy: DEFAULT_LIVE_PREFERENCES.mainPolicy,
                countdownSec: DEFAULT_LIVE_PREFERENCES.countdownSec,
                custom: DEFAULT_LIVE_PREFERENCES.custom,
              })
            }
          >
            Restore defaults
          </button>
        </div>
        <Row label="Main window" hint="Keep your pick, or let the biggest moment take over.">
          <Segmented<'user' | 'follow'>
            label="Main window"
            value={live.mainPolicy}
            onChange={(mainPolicy) => updateLive({ mainPolicy })}
            options={[
              { value: 'user', label: 'My choice' },
              { value: 'follow', label: 'Follow action' },
            ]}
          />
        </Row>
        <Row label="Pace" hint={paceHint(live.pace, effective)}>
          <Segmented
            label="Switching pace"
            value={live.pace}
            onChange={(pace) => updateLive({ pace })}
            options={[...PACES.map((p) => ({ value: p.id, label: p.name })), { value: 'custom' as const, label: 'Custom' }]}
          />
        </Row>
        {live.pace === 'custom' && (
          <div className={styles.sliders}>
            <Slider
              label="Minimum time on screen"
              unit="s"
              min={5}
              max={90}
              step={5}
              value={live.custom.minDisplaySec}
              onChange={(minDisplaySec) => updateLive({ custom: { ...live.custom, minDisplaySec } })}
            />
            <Slider
              label="Must beat by"
              unit=" pts"
              min={2}
              max={30}
              step={1}
              value={live.custom.margin}
              onChange={(margin) => updateLive({ custom: { ...live.custom, margin } })}
            />
            <Slider
              label="For at least"
              unit="s"
              min={1}
              max={15}
              step={1}
              value={live.custom.challengeSec}
              onChange={(challengeSec) => updateLive({ custom: { ...live.custom, challengeSec } })}
            />
          </div>
        )}
        <Row label="Warning" hint="Show “Switching to …” with a countdown, so you can keep the current feed.">
          <Segmented<string>
            label="Switch warning"
            value={String(live.countdownSec)}
            onChange={(v) => updateLive({ countdownSec: Number(v) })}
            options={[
              { value: '0', label: 'Off' },
              { value: '3', label: '3 s' },
              { value: '5', label: '5 s' },
              { value: '8', label: '8 s' },
            ]}
          />
        </Row>
      </section>

      <section className={base.section} aria-labelledby="animation">
        <h2 id="animation" className={base.heading}>
          Switch animation
        </h2>
        <div className={styles.anims} role="radiogroup" aria-label="Switch animation">
          {ANIMATIONS.map((a) => (
            <AnimationCard
              key={a.id}
              id={a.id}
              name={a.name}
              description={a.description}
              selected={live.animation === a.id}
              posters={posters}
              onSelect={() => updateLive({ animation: a.id })}
            />
          ))}
        </div>
      </section>
    </>
  );
}

function paceHint(pace: string, c: { minDisplayMs: number; replaceMargin: number; challengeMs: number }): string {
  const rule = `A feed stays at least ${Math.round(c.minDisplayMs / 1000)} s; a challenger must lead by ${c.replaceMargin} points for ${(c.challengeMs / 1000).toFixed(c.challengeMs % 1000 ? 1 : 0)} s.`;
  return pace === 'custom' ? rule : `${PACES.find((p) => p.id === pace)?.hint ?? ''}. ${rule}`;
}

function Slider({
  label,
  unit,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={styles.slider}>
      <span className={styles.sliderLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--pct': `${pct}%` } as CSSProperties}
      />
      <span className={`${styles.sliderValue} mono`}>
        {value}
        {unit}
      </span>
    </label>
  );
}

function LayoutDiagram({ id, side }: { id: LayoutId; side: 'left' | 'right' }) {
  const def = layoutDef(id);
  return (
    <span className={styles.diagram} data-layout={id} data-side={def.sided ? side : undefined} aria-hidden>
      <span className={styles.dMain} />
      {def.sideSlots.map((s) => (
        <span key={s} className={styles.dSide} data-slot={s} />
      ))}
      {def.table && (
        <span className={styles.dTable} data-slot="table">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

/**
 * Selectable animation with a live preview: two feeds (posters from what's live now, or brand
 * gradients) switching with the real stage CSS. Plays on hover/focus and once when selected.
 */
function AnimationCard({
  id,
  name,
  description,
  selected,
  posters,
  onSelect,
}: {
  id: SwitchAnimation;
  name: string;
  description: string;
  selected: boolean;
  posters: string[];
  onSelect: () => void;
}) {
  const reduced = useReducedMotion();
  const revealMs = revealMsFor(id, reduced);
  const [run, setRun] = useState(0);
  const [hovering, setHovering] = useState(false);
  const timer = useRef<number>();
  const play = () => setRun((n) => n + 1);

  useEffect(() => {
    if (!hovering) return;
    play();
    const t = window.setInterval(play, revealMs + 1300);
    return () => clearInterval(t);
  }, [hovering, revealMs]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const offset = ['spotlight', 'stinger', 'flip'].indexOf(id) * 2;
  const a = posters[(offset + run) % Math.max(1, posters.length)];
  const b = posters[(offset + run + 1) % Math.max(1, posters.length)];
  const fxStyle = { '--fx-reveal': `${revealMs}ms`, '--fx-ox': 'calc(100% - 18px)', '--fx-oy': '14px' } as CSSProperties;

  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={selected}
      className={`${styles.animCard} ${selected ? styles.on : ''}`}
      onClick={() => {
        onSelect();
        play();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
          play();
        }
      }}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={() => setHovering(false)}
    >
      <span className={styles.preview}>
        {/* Outgoing then incoming: remounted per run so the animation restarts. */}
        <span key={`out-${run}`} className={`sl-fx-layer ${run ? 'is-exiting' : ''} ${styles.pLayer}`} data-fx={reduced ? 'none' : id} style={fxStyle}>
          <span className={`sl-fx ${styles.pFeed}`} data-tone="a">
            {a && <img src={a} alt="" />}
          </span>
        </span>
        {run > 0 && (
          <span key={`in-${run}`} className={`sl-fx-layer is-entering ${styles.pLayer}`} data-fx={reduced ? 'none' : id} style={fxStyle}>
            <span className={`sl-fx ${styles.pFeed}`} data-tone="b">
              {b && <img src={b} alt="" />}
              <span className={`${styles.pBadge} mono`}>94</span>
            </span>
            <span className="sl-fx-overlay">
              {id === 'stinger' && (
                <span className="sl-sting">
                  <LogoMark size={40} />
                </span>
              )}
            </span>
          </span>
        )}
        <span className={styles.playHint} aria-hidden>
          <Play size={12} fill="currentColor" />
        </span>
      </span>
      <span className={styles.cardName}>{name}</span>
      <span className={styles.cardHint}>{description}</span>
    </div>
  );
}

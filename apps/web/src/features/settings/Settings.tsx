import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronRight, ExternalLink, Monitor, Moon, Sun } from 'lucide-react';
import { SPORTS, type SportId } from '@sportlight/shared';
import { mediaUrl } from '../../lib/env';
import { useLive } from '../../lib/live-client';
import { COLOUR_THEMES, usePreferences, type MotionPreference, type ThemePreference } from '../../lib/preferences';
import { Row, Segmented } from './controls';
import { LiveSettings } from './LiveSettings';
import styles from './Settings.module.scss';

interface Credit {
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
}

export function Settings() {
  const { prefs, sports, update, reset } = usePreferences();
  const { status } = useLive();
  const navigate = useNavigate();
  const { hash } = useLocation();

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Settings</h1>

      <section className={styles.section} aria-labelledby="appearance">
        <h2 id="appearance" className={styles.heading}>
          Appearance
        </h2>
        <Row label="Theme" hint="Follow your device, or choose light or dark.">
          <Segmented<ThemePreference>
            label="Theme"
            value={prefs.theme}
            onChange={(theme) => update({ theme })}
            options={[
              { value: 'system', label: 'System', icon: <Monitor size={15} /> },
              { value: 'light', label: 'Light', icon: <Sun size={15} /> },
              { value: 'dark', label: 'Dark', icon: <Moon size={15} /> },
            ]}
          />
        </Row>
        <Row label="Colour theme" hint="Choose your primary colour. Works in light and dark mode.">
          <div className={styles.colours} role="group" aria-label="Colour theme">
            {COLOUR_THEMES.map((theme) => (
              <button
                key={theme.value}
                type="button"
                data-colour={theme.value}
                aria-pressed={prefs.colour === theme.value}
                className={styles.colourOption}
                onClick={() => update({ colour: theme.value })}
              >
                <span className={styles.swatch} aria-hidden="true" />
                {theme.label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Motion" hint="Reduce animation everywhere. Sportlight also follows your device setting.">
          <Segmented<MotionPreference>
            label="Motion"
            value={prefs.motion}
            onChange={(motion) => update({ motion })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'reduce', label: 'Reduced' },
            ]}
          />
        </Row>
      </section>

      <LiveSettings />

      <section className={styles.section} aria-labelledby="sports">
        <h2 id="sports" className={styles.heading}>
          Your sports
        </h2>
        <Row
          label={sports.length ? sportNames(sports) : 'No sports selected'}
          hint={`${sports.length} of ${SPORTS.length} followed`}
        >
          <Link to="/settings/sports" className="sl-button small secondary">
            Manage <ChevronRight size={15} />
          </Link>
        </Row>
      </section>

      <section className={styles.section} aria-labelledby="about">
        <h2 id="about" className={styles.heading}>
          About
        </h2>
        <Row label="Live service" hint={status === 'open' ? 'Connected' : 'Reconnecting…'}>
          <Link to="/admin" className="sl-button small secondary">
            Stream admin
          </Link>
        </Row>
        <Row label="Tour" hint="Choose your sports and see the live page tour again.">
          <button
            type="button"
            className="sl-button small secondary"
            onClick={() => {
              update({ onboarded: false });
              navigate('/live');
            }}
          >
            Replay
          </button>
        </Row>
        <Row label="Reset" hint="Clear your sports, theme and votes on this device.">
          <button
            type="button"
            className="sl-button small secondary"
            onClick={() => {
              if (confirm('Reset Sportlight on this device?')) {
                reset();
                navigate('/', { replace: true });
              }
            }}
          >
            Reset
          </button>
        </Row>
        <Credits />
      </section>
    </main>
  );
}

function sportNames(ids: SportId[]) {
  const names = SPORTS.filter((s) => ids.includes(s.id)).map((s) => s.name);
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

/** Source attribution for the local demo replays. */
function Credits() {
  const [credits, setCredits] = useState<Array<{ id: string; credits: Credit[]; synthetic: boolean }> | null>(null);
  useEffect(() => {
    fetch(mediaUrl('/media/catalog.json')!)
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { clips: Array<{ id: string; credits: Credit[]; synthetic: boolean }> } | null) =>
        setCredits(c?.clips ?? []),
      )
      .catch(() => setCredits([]));
  }, []);
  const all = credits?.flatMap((c) => c.credits) ?? [];
  return (
    <details className={styles.credits}>
      <summary>Demo media credits</summary>
      {all.length === 0 ? (
        <p className={styles.hint}>{credits === null ? 'Loading…' : 'No third-party media in this build.'}</p>
      ) : (
        <ul>
          {all.map((c) => (
            <li key={c.title}>
              <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="sl-link">
                {c.title}
                <ExternalLink size={12} />
              </a>{' '}
              <span className={styles.hint}>
                {c.author} ·{' '}
                {c.licenseUrl ? (
                  <a href={c.licenseUrl} target="_blank" rel="noreferrer">
                    {c.license}
                  </a>
                ) : (
                  c.license
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.hint}>Full broadcast replays from YouTube, played locally at normal speed.</p>
    </details>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ExternalLink, Monitor, Moon, Sun } from 'lucide-react';
import { SportPicker } from '../../components/SportPicker';
import { mediaUrl } from '../../lib/env';
import { useLive } from '../../lib/live-client';
import { usePreferences, type MotionPreference, type ThemePreference } from '../../lib/preferences';
import styles from './Settings.module.scss';

interface Credit {
  title: string;
  author: string;
  license: string;
  licenseUrl: string | null;
  sourceUrl: string;
}

export function Settings() {
  const { prefs, sports, update, setSports, reset } = usePreferences();
  const { feeds, status } = useLive();
  const feedList = useMemo(() => Object.values(feeds), [feeds]);
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

      <section className={styles.section} aria-labelledby="sports">
        <div className={styles.sectionHead}>
          <h2 id="sports" className={styles.heading}>
            Your sports
          </h2>
          <span className={styles.meta}>Changes apply immediately</span>
        </div>
        <SportPicker selected={sports} onChange={setSports} feeds={feedList} />
        {sports.length === 0 && <p className={styles.warn}>Select at least one sport to see live feeds.</p>}
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
        <Row label="Welcome tour" hint="See the introduction again.">
          <button type="button" className="sl-button small secondary" onClick={() => navigate('/welcome')}>
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
                navigate('/welcome', { replace: true });
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

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className={styles.row}>
      <div>
        <div className={styles.label}>{label}</div>
        {hint && <div className={styles.hint}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? styles.segOn : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Attribution for the openly licensed demo footage (required by CC BY / BY-SA). */
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
      <p className={styles.hint}>Footage via Wikimedia Commons, trimmed and re-encoded for this demo.</p>
    </details>
  );
}

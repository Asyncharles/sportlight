import { flushSync } from 'react-dom';

interface ViewTransition {
  finished: Promise<void>;
  ready: Promise<void>;
  skipTransition(): void;
}

let active: ViewTransition | undefined;
let fallback: Animation | undefined;

/** Snapshot the live stage around a view change without replacing its video elements. */
export function switchView(update: () => void) {
  active?.skipTransition();
  fallback?.cancel();

  const reduced =
    document.documentElement.dataset.motion === 'reduce' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const commit = () => flushSync(update);
  if (reduced) {
    commit();
    return;
  }

  const doc = document as Document & {
    startViewTransition?: (update: () => void) => ViewTransition;
  };
  if (!doc.startViewTransition) {
    commit();
    const stage = document.querySelector<HTMLElement>('[data-view-stage]');
    fallback = stage?.animate(
      [
        { opacity: 0.35, transform: 'translateY(12px) scale(0.985)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 460, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
    return;
  }

  const transition = doc.startViewTransition(commit);
  active = transition;
  // A hidden tab or interrupted capture can skip the animation; the view still updates.
  void transition.ready.catch(() => {});
  void transition.finished.catch(() => {}).finally(() => {
    if (active === transition) active = undefined;
  });
}

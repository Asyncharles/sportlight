import { matchesFollows, type Follow, type SportId } from '@sportlight/shared';
import { Store, useStore } from './store';

/**
 * Best of Today filter, shared by the page and its header filter dialog. Survives navigation.
 * `sports: null` means "follow my sports" (tracks the viewer's follows as they change).
 */
export const bestUi = new Store<{ sports: SportId[] | null }>({ sports: null });

export function useBestUi() {
  const { sports } = useStore(bestUi);
  return { sports, setSports: (sports: SportId[] | null) => bestUi.set(() => ({ sports })) };
}

export function matchesBestFilter(
  item: Parameters<typeof matchesFollows>[0],
  sports: readonly SportId[] | null,
  follows: readonly Follow[],
) {
  return sports ? sports.includes(item.sportId) : matchesFollows(item, follows);
}

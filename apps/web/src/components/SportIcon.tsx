import {
  BallWave,
  Bike,
  ChessKnight,
  Flag,
  Footprints,
  Gamepad2,
  Goal,
  HockeyStick,
  RugbyBall,
  Trophy,
  Volleyball,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { getSport, type SportIconName } from '@sportlight/shared';

const ICONS: Record<SportIconName, LucideIcon> = {
  goal: Goal,
  volleyball: Volleyball,
  'ball-wave': BallWave,
  flag: Flag,
  'hockey-stick': HockeyStick,
  bike: Bike,
  'rugby-ball': RugbyBall,
  'chess-knight': ChessKnight,
  'gamepad-2': Gamepad2,
  footprints: Footprints,
};

export function SportIcon({ sportId, ...props }: { sportId: string } & LucideProps) {
  const sport = getSport(sportId);
  const Icon = sport ? ICONS[sport.icon] : Trophy;
  return <Icon aria-hidden {...props} />;
}

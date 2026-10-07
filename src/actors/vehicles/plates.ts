import { Rng } from '@/engine/core/rng';

const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const BLOCKED = [
  'ASS',
  'CUM',
  'FAG',
  'FCK',
  'FUK',
  'KKK',
  'NGR',
  'SEX',
  'WTF',
];

const issued = new Set<string>();

function draw(rng: Rng): string {
  const letters = Array.from({ length: 3 }, () =>
    LETTERS.charAt(rng.int(0, LETTERS.length - 1)),
  ).join('');
  return `${letters}-${String(rng.int(0, 9999)).padStart(4, '0')}`;
}

export function licensePlate(
  seed: number,
  taken: ReadonlySet<string> = new Set(),
): string {
  const rng = new Rng(seed);
  let plate = draw(rng);
  while (taken.has(plate) || BLOCKED.some((word) => plate.startsWith(word))) {
    plate = draw(rng);
  }

  return plate;
}

export function issuePlate(seed: number): string {
  const plate = licensePlate(seed, issued);
  issued.add(plate);
  return plate;
}

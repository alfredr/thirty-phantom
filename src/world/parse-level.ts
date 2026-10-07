import validateV1 from 'virtual:level-validator';

import type { LevelData } from './level-data';

function fail(path: string, expected: string): never {
  throw new Error(`${path}: expected ${expected}`);
}

function ordered(values: number[], path: string): void {
  for (let i = 1; i < values.length; i++) {
    if (values[i]! <= values[i - 1]!) {
      fail(`${path}[${i}]`, 'a height above the previous floor');
    }
  }
}

/**
 * Validate the declared format before applying its defaults and checking
 * geometry.
 */
export function parseLevel(json: unknown): LevelData {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    fail('level', 'an object');
  }

  if (!('version' in json)) {
    fail('level.version', 'a format version');
  }

  switch (json.version) {
    case 1:
      return parseV1(json);
    default:
      throw new Error(
        'level.version: unsupported format version (expected 1)',
      );
  }
}

function parseV1(json: object): LevelData {
  // Ajv inserts only top-level defaults. Copy the root so the caller's object is unchanged.
  const result = { ...json };
  if (!validateV1(result)) {
    const error = validateV1.errors?.[0];
    let path = 'level';
    if (error) {
      for (const part of error.instancePath.split('/').slice(1)) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        path += /^\d+$/.test(key) ? `[${key}]` : `.${key}`;
      }

      const field =
        error.params.missingProperty ?? error.params.additionalProperty;
      if (typeof field === 'string') {
        path += `.${field}`;
      }
    }

    throw new Error(`${path}: ${error?.message ?? 'invalid level'}`);
  }

  for (const key of [
    'boxes',
    'ramps',
    'ghostZones',
    'gates',
    'fences',
    'pits',
    'elevators',
    'buildings',
  ] as const) {
    result[key].forEach((b, i) => checkBounds(b, `level.${key}[${i}]`));
  }

  checkBounds(result.deck, 'level.deck');
  ordered(result.deck.floors, 'level.deck.floors');
  result.spots.forEach((spot, i) => {
    // Garage lookups use spot IDs as array indices.
    if (spot.id !== i) {
      fail(`level.spots[${i}].id`, `${i} (the spot's array index)`);
    }

    if (spot.level >= result.deck.floors.length) {
      fail(`level.spots[${i}].level`, 'an existing deck floor');
    }
  });
  result.ramps.forEach((ramp, i) => {
    const axis = ramp.axis === 'x' ? 0 : 2;
    if (ramp.max[axis] <= ramp.min[axis]) {
      fail(`level.ramps[${i}].max[${axis}]`, 'a ramp with positive length');
    }

    if (ramp.low < ramp.min[1] || ramp.low > ramp.max[1]) {
      fail(`level.ramps[${i}].low`, 'a height within the ramp bounds');
    }
  });
  result.paths.forEach(({ points }, i) => {
    if (points.every((p) => p.every((v, axis) => v === points[0]![axis]))) {
      fail(`level.paths[${i}].points`, 'at least two distinct points');
    }
  });
  result.elevators.forEach((elevator, i) => {
    ordered(
      elevator.stops.map((s) => s.y),
      `level.elevators[${i}].stops`,
    );
    elevator.stops.forEach((stop, j) => {
      if (stop.y < elevator.min[1] || stop.y > elevator.max[1]) {
        fail(
          `level.elevators[${i}].stops[${j}].y`,
          'a height within the shaft',
        );
      }
    });
  });
  result.buildings.forEach((building, i) => {
    const rect = building.core?.rect;
    if (rect && (rect[0] >= rect[2] || rect[1] >= rect[3])) {
      fail(
        `level.buildings[${i}].core.rect`,
        'an ordered rectangle with positive area',
      );
    }
  });
  return result;
}

function checkBounds(
  { min, max }: Pick<LevelData['deck'], 'min' | 'max'>,
  path: string,
): void {
  for (let i = 0; i < 3; i++) {
    if (min[i]! > max[i]!) {
      fail(`${path}.max[${i}]`, 'a coordinate at or above min');
    }
  }
}

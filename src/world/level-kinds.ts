/** Names shared by the level format and renderer. */
export const MAT_KEYS = [
  'invisible', 'concrete', 'concreteDark', 'concreteLight', 'asphalt', 'sidewalk', 'roof', 'facadeA', 'facadeB',
  'facadeC', 'metal', 'metalLight', 'stone', 'grass', 'wood', 'slime', 'slimePool', 'neonGreen', 'neonPurple',
  'lampGreen', 'lampPurple', 'lampWarm', 'linePurple', 'lineGreen', 'marking', 'hazard', 'glass', 'doorGlow',
] as const;
export type MatKey = (typeof MAT_KEYS)[number];

export const SIGN_STYLES = ['banner', 'level', 'checker', 'neon', 'neonPurple', 'foxy', 'billboard', 'scanner', 'dial'] as const;
export type SignStyle = (typeof SIGN_STYLES)[number];

export const DECOR_KINDS = ['tree', 'pine', 'cypress', 'bush', 'hedge', 'flowersSlime', 'flowersPurple', 'fountain', 'gazebo', 'shelter', 'bench'] as const;
export type DecorKind = (typeof DECOR_KINDS)[number];

declare module 'virtual:level-validator' {
  // useDefaults fills every optional top-level field before a successful check returns.
  const validate: import('ajv').ValidateFunction<import('./world/level-data').LevelData>;
  export default validate;
}

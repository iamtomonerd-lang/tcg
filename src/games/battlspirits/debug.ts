/**
 * Debug log categories. Only flash-timing logs are on by default.
 * Each flag can be overridden via environment variable, e.g.:
 *   DEBUG_EFFECT=true npm run web:dev   (enable effect logs)
 *   DEBUG_FLASH=false npm run web:dev   (silence flash logs)
 */
const envFlag = (name: string, defaultValue: boolean): boolean => {
  if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
    const v = process.env[name];
    return v !== 'false' && v !== '0';
  }
  return defaultValue;
};

export const DEBUG_FLASH = envFlag('DEBUG_FLASH', true); // flash timing windows, passes, battle resolution
export const DEBUG_EFFECT = envFlag('DEBUG_EFFECT', false); // card effect processing details
export const DEBUG_CORE = envFlag('DEBUG_CORE', false); // core/soul-core count changes
export const DEBUG_VERBOSE = envFlag('DEBUG_VERBOSE', false); // phase transitions, actions, init, server traffic

// AI tree search (ISMCTS) replays applyAction thousands of times per decision;
// logs are suspended around agent.chooseAction so only real game actions are logged.
let suspended = false;
export const suspendGameLogs = (s: boolean): void => {
  suspended = s;
};

/** Log only when the category flag is on and logs are not suspended (AI simulation). */
export const dbg = (flag: boolean, ...args: unknown[]): void => {
  if (flag && !suspended) console.log(...args);
};

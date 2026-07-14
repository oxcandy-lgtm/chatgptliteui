/** Lightweight structured logger that never prints chat content. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function emit(level: LogLevel, scope: string, message: string, ...rest: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const prefix = `[cgl:${scope}]`;
  // Rest arguments are intentionally limited to non-sensitive diagnostic data.
  const args = rest.length > 0 ? [prefix, message, ...rest] : [prefix, message];
  switch (level) {
    case "debug":
      console.debug(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "error":
      console.error(...args);
      break;
  }
}

export const logger = {
  debug: (scope: string, message: string, ...rest: unknown[]): void =>
    emit("debug", scope, message, ...rest),
  info: (scope: string, message: string, ...rest: unknown[]): void =>
    emit("info", scope, message, ...rest),
  warn: (scope: string, message: string, ...rest: unknown[]): void =>
    emit("warn", scope, message, ...rest),
  error: (scope: string, message: string, ...rest: unknown[]): void =>
    emit("error", scope, message, ...rest),
};

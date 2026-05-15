import { toPositiveInteger } from "./common.mjs";

export function parseArgs(argv, defaults = {}) {
  const args = { ...defaults, _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (rawKey.startsWith("no-")) {
      const positive = rawKey
        .slice(3)
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      args[positive] = false;
      continue;
    }
    const next = inlineValue ?? argv[index + 1];
    if (inlineValue == null && (next == null || String(next).startsWith("--"))) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    if (inlineValue == null) index += 1;
  }
  return args;
}

export function intArg(args, key, fallback = 0) {
  return toPositiveInteger(args[key], `--${key}`, fallback);
}

export function boolArg(args, key, fallback = false) {
  if (args[key] == null) return fallback;
  if (typeof args[key] === "boolean") return args[key];
  return !/^(0|false|no)$/i.test(String(args[key]));
}

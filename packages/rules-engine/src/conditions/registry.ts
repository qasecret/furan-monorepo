import type { ConditionHandler, DiffRegion, MatchCandidate } from "../types.js";

// Keys that JSON.parse of a jsonb column can smuggle in as own-enumerable
// properties (notably "__proto__"). They are never valid condition names, so
// drop them before lookup rather than treating them as unknown conditions.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class ConditionRegistry {
  private handlers = new Map<string, ConditionHandler>();
  private frozen = false;

  register(name: string, handler: ConditionHandler): void {
    if (this.frozen) {
      throw new Error(`ConditionRegistry is frozen; cannot register "${name}"`);
    }
    this.handlers.set(name, handler);
  }

  evaluateAll(
    conditions: Record<string, unknown> | null,
    context: { region: DiffRegion; candidate: MatchCandidate },
  ): boolean {
    if (!conditions) return true;
    for (const [name, config] of Object.entries(conditions)) {
      // Ignore prototype-polluting keys (e.g. "__proto__") that JSON.parse of a
      // jsonb column can introduce; they are noise, not conditions.
      if (RESERVED_KEYS.has(name)) continue;
      const handler = this.handlers.get(name);
      // Fail SAFE on an unknown condition name (typo or a forward-compat
      // condition this engine version doesn't implement): the rule's guard
      // cannot be evaluated, so the rule must NOT match. Silently skipping it
      // would make the rule fire *more* permissively — dangerous for an
      // auto_approve rule whose maxDiff cap was mistyped.
      if (!handler) return false;
      if (!handler(config, context)) return false;
    }
    return true;
  }

  freeze(): void {
    this.frozen = true;
  }
}

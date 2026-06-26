import type { ConditionHandler, DiffRegion, MatchCandidate } from "../types.js";

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
      const handler = this.handlers.get(name);
      if (!handler) continue;
      if (!handler(config, context)) return false;
    }
    return true;
  }

  freeze(): void {
    this.frozen = true;
  }
}

import type {
  DiffRegion,
  ElementMap,
  MatchCandidate,
  MatcherHandler,
} from "../types.js";

export class MatcherRegistry {
  private handlers = new Map<string, MatcherHandler>();
  private frozen = false;

  register(type: string, handler: MatcherHandler): void {
    if (this.frozen) {
      throw new Error(`MatcherRegistry is frozen; cannot register "${type}"`);
    }
    this.handlers.set(type, handler);
  }

  resolve(
    match: { type: string; value: unknown },
    region: DiffRegion,
    elementMap: ElementMap | null,
  ): MatchCandidate {
    const handler = this.handlers.get(match.type);
    if (!handler) {
      return { matched: false, overlap: 0, resolvedSelector: null };
    }
    return handler(match.value, region, elementMap);
  }

  freeze(): void {
    this.frozen = true;
  }
}

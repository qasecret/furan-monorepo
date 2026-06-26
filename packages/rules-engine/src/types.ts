export type Action = "auto_approve" | "flag";

export const SEVERITY: Record<Action, number> = {
  auto_approve: 1,
  flag: 2,
};

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffRegion {
  id: string;
  severity: string;
  category: string;
  bbox: Bbox;
  description: string;
  source: string;
  diffPercent: number;
  viewport?: string;
}

export interface ElementMapEntry {
  selector: string;
  bbox: Bbox;
}

export type ElementMap = ElementMapEntry[];

export interface AutoRule {
  id: string;
  version: number;
  label: string;
  enabled: boolean;
  match: { type: string; value: unknown };
  conditions: Record<string, unknown> | null;
  action: Action;
}

export interface MatchCandidate {
  matched: boolean;
  overlap: number;
  resolvedSelector: string | null;
}

export interface RuleMatch {
  ruleId: string;
  ruleVersion: number;
  ruleLabel: string;
  action: Action;
  severity: number;
  regionDiffPct: number;
  won: boolean;
}

export interface RegionDecision {
  regionId: string;
  matchedRules: RuleMatch[];
  winningRule: RuleMatch | null;
  finalAction: Action | null;
}

export interface EvaluationDiagnostics {
  evaluatedRules: number;
  matchedRules: number;
  skippedBecauseNoElementMap: number;
  selectorMisses: number;
  durationMs: number;
}

export interface EvaluationResult {
  decisions: RegionDecision[];
  counts: Record<Action | "unmatched", number>;
  diagnostics: EvaluationDiagnostics;
}

export type MatcherHandler = (
  matchConfig: unknown,
  region: DiffRegion,
  elementMap: ElementMap | null,
) => MatchCandidate;

export type ConditionHandler = (
  config: unknown,
  context: { region: DiffRegion; candidate: MatchCandidate },
) => boolean;

export interface CompiledRule {
  id: string;
  version: number;
  label: string;
  action: Action;
  matcher: (
    region: DiffRegion,
    elementMap: ElementMap | null,
  ) => MatchCandidate;
  conditions: (region: DiffRegion, candidate: MatchCandidate) => boolean;
  severity: number;
}

export interface CompiledRuleset {
  version: number;
  rules: CompiledRule[];
  diagnostics: { compiledAt: number };
}

export interface PolicyContext {
  region: DiffRegion;
  matches: RuleMatch[];
}

export interface EvaluationInput {
  diffRegions: DiffRegion[];
  elementMap: ElementMap | null;
  rules: AutoRule[];
}

export interface CompiledEvaluationInput {
  diffRegions: DiffRegion[];
  elementMap: ElementMap | null;
  ruleset: CompiledRuleset;
}

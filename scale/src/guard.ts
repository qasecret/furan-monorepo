import {
  BUDGETS,
  type Budget,
  type Measurement,
  type Suite,
} from "./budgets.js";
import { describeError } from "./errors.js";

/**
 * Runs one suite so that it cannot take the others down. If it throws (or has
 * no runner at all), every budget of the suite is reported as `error` with the
 * message, so the run fails and the report says why, while the remaining
 * suites still run.
 */
export async function runSuiteGuarded(
  suite: Suite,
  run: (() => Promise<Measurement[]>) | undefined,
  budgets: readonly Budget[] = BUDGETS,
): Promise<Measurement[]> {
  try {
    if (run === undefined) {
      throw new Error(`the ${suite} suite is not implemented in this build`);
    }
    return await run();
  } catch (error) {
    const message = describeError(error);
    return budgets
      .filter((budget) => budget.suite === suite)
      .map((budget) => ({ id: budget.id, value: null, error: message }));
  }
}

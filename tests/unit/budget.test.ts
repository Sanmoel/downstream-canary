import { describe, expect, it } from 'vitest';
import { RunBudget } from '../../src/budget.js';

describe('monotonic run budget', () => {
  it('caps commands to remaining whole-run time and fails after expiry', () => {
    let now = 1000;
    const budget = new RunBudget(600, 10, 'test run', () => now);
    expect(budget.timeoutMilliseconds('first')).toBe(10_000);
    now += 9_250;
    expect(budget.timeoutMilliseconds('last')).toBe(750);
    now += 750;
    expect(() => budget.timeoutMilliseconds('expired')).toThrow(
      /deadline was exhausted/,
    );
  });

  it('allocates a bounded share to each remaining consumer', () => {
    let now = 0;
    const budget = new RunBudget(600, 90, 'test run', () => now);
    const consumer = budget.forRemainingConsumer('acme/tool', 3);
    expect(consumer.remainingMilliseconds()).toBe(30_000);
    now = 30_000;
    expect(() => consumer.timeoutMilliseconds('next phase')).toThrow(
      /Consumer acme\/tool deadline/,
    );
    expect(budget.remainingMilliseconds()).toBe(60_000);
  });
});

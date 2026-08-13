import { CanaryError } from './errors.js';

type Clock = () => number;

export class RunBudget {
  readonly #commandTimeoutSeconds: number;
  readonly #deadlineMs: number;
  readonly #clock: Clock;
  readonly #label: string;

  public constructor(
    commandTimeoutSeconds: number,
    wholeRunTimeoutSeconds: number,
    label = 'whole run',
    clock: Clock = () => performance.now(),
    parentDeadlineMs?: number,
  ) {
    this.#commandTimeoutSeconds = commandTimeoutSeconds;
    this.#clock = clock;
    this.#label = label;
    const ownDeadline = clock() + wholeRunTimeoutSeconds * 1000;
    this.#deadlineMs = Math.min(ownDeadline, parentDeadlineMs ?? ownDeadline);
  }

  public remainingMilliseconds(): number {
    return Math.max(0, this.#deadlineMs - this.#clock());
  }

  public timeoutMilliseconds(phase: string, requestedMs?: number): number {
    const remaining = this.remainingMilliseconds();
    if (remaining < 1) {
      throw new CanaryError(
        'infrastructure',
        'timeout',
        `${this.#label} deadline was exhausted before ${phase}.`,
      );
    }
    return Math.max(
      1,
      Math.floor(
        Math.min(
          remaining,
          requestedMs ?? this.#commandTimeoutSeconds * 1000,
        ),
      ),
    );
  }

  public timeoutSeconds(phase: string): number {
    return Math.max(1, Math.ceil(this.timeoutMilliseconds(phase) / 1000));
  }

  public forRemainingConsumer(
    consumer: string,
    remainingConsumerCount: number,
  ): RunBudget {
    if (!Number.isInteger(remainingConsumerCount) || remainingConsumerCount < 1) {
      throw new Error('Remaining consumer count must be a positive integer.');
    }
    const allocationMs = Math.floor(
      this.remainingMilliseconds() / remainingConsumerCount,
    );
    if (allocationMs < 1) {
      this.timeoutMilliseconds(`consumer ${consumer}`);
    }
    return new RunBudget(
      this.#commandTimeoutSeconds,
      Math.max(1, allocationMs) / 1000,
      `Consumer ${consumer}`,
      this.#clock,
      this.#deadlineMs,
    );
  }
}

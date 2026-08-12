import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ActionMetadata {
  readonly runs?: { readonly using?: string; readonly main?: string };
  readonly outputs?: Record<string, unknown>;
}

interface WorkflowStep {
  readonly uses?: string;
}

interface Workflow {
  readonly permissions?: Record<string, string>;
  readonly on?: Record<string, unknown>;
  readonly jobs?: Record<string, { readonly 'runs-on'?: string; readonly steps?: WorkflowStep[] }>;
}

describe('GitHub metadata', () => {
  it('targets Node 24 and exposes the required outputs', async () => {
    const action = parse(await readFile('action.yml', 'utf8')) as ActionMetadata;
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/action.js' });
    expect(action.outputs).toHaveProperty('report-path');
    expect(action.outputs).toHaveProperty('regression-count');
  });

  it('uses the safe event, least privilege, Ubuntu, and commit-pinned actions', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8')) as Workflow;
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).not.toHaveProperty('pull_request_target');

    for (const job of Object.values(workflow.jobs ?? {})) {
      expect(job['runs-on']).toBe('ubuntu-latest');
      for (const step of job.steps ?? []) {
        if (!step.uses || step.uses.startsWith('./')) continue;
        expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/);
      }
    }
  });
});

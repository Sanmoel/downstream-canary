import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ActionMetadata {
  readonly runs?: { readonly using?: string; readonly main?: string };
  readonly outputs?: Record<string, unknown>;
  readonly inputs?: Record<string, { readonly required?: boolean }>;
}

interface WorkflowStep {
  readonly uses?: string;
}

interface Workflow {
  readonly permissions?: Record<string, string>;
  readonly on?: Record<string, unknown>;
  readonly jobs?: Record<string, {
    readonly 'runs-on'?: string;
    readonly 'timeout-minutes'?: number;
    readonly steps?: WorkflowStep[];
  }>;
}

describe('GitHub metadata', () => {
  it('targets Node 24 and exposes the required outputs', async () => {
    const action = parse(await readFile('action.yml', 'utf8')) as ActionMetadata;
    expect(action.runs).toEqual({ using: 'node24', main: 'dist/action.js' });
    expect(action.outputs).toHaveProperty('report-path');
    expect(action.outputs).toHaveProperty('regression-count');
    expect(action.inputs).not.toHaveProperty('config');
    expect(action.inputs?.consumers?.required).toBe(true);
  });

  it('uses the safe event, least privilege, Ubuntu, and commit-pinned actions', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8')) as Workflow;
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).not.toHaveProperty('pull_request_target');

    for (const job of Object.values(workflow.jobs ?? {})) {
      expect(job['runs-on']).toBe('ubuntu-latest');
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      for (const step of job.steps ?? []) {
        if (!step.uses || step.uses.startsWith('./')) continue;
        expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/);
      }
    }
  });

  it('distributes exact notices for bundled runtime dependencies', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      readonly files?: readonly string[];
    };
    const notices = await readFile('THIRD_PARTY_NOTICES', 'utf8');
    expect(manifest.files).toContain('THIRD_PARTY_NOTICES');
    expect(notices).toContain('jsonc-parser 3.3.1');
    expect(notices).toContain('yaml 2.9.0');
  });
});

import { describe, expect, test } from 'vitest';
import { ToolConfirmations } from '../../src/ui/confirmations';

const call = { mode: 'generate', filePath: 'src/age.ts', functionName: 'isEligible' };

describe('ToolConfirmations', () => {
  test('invoke runs only the run the latest prepare confirmed, once', () => {
    const c = new ToolConfirmations();
    c.confirm(call, 'run A');
    expect(c.take(call, 'run A')).toBe(true);
    expect(c.take(call, 'run A')).toBe(false);
  });

  test('a change of files or model between confirmation and run does not run', () => {
    const c = new ToolConfirmations();
    c.confirm(call, 'run A');
    expect(c.take(call, 'run A with another model')).toBe(false);
    // The confirmation is used up: the old run cannot be invoked either.
    expect(c.take(call, 'run A')).toBe(false);
  });

  test('a declined confirmation followed by a prepare without one leaves nothing to run', () => {
    const c = new ToolConfirmations();
    c.confirm(call, 'run A'); // shown, declined: no invoke
    c.clear(call); // the next prepare could not resolve the run (for example no model listed for a moment)
    expect(c.take(call, 'run A')).toBe(false);
  });

  test('confirmations are kept per mode, file and function', () => {
    const c = new ToolConfirmations();
    c.confirm(call, 'run A');
    c.confirm({ ...call, mode: 'audit' }, 'run B');
    expect(c.take({ ...call, functionName: undefined }, 'run A')).toBe(false);
    expect(c.take({ ...call, mode: 'audit' }, 'run A')).toBe(false);
    expect(c.take(call, 'run A')).toBe(true);
  });
});

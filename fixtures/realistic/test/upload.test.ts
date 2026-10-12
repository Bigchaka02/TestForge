import { beforeEach, describe, expect, it } from 'vitest';
import { uploadName } from '../src/upload.js';

describe('uploadName', () => {
  let names: string[];

  beforeEach(() => {
    names = [];
  });

  it.each([
    ['Report Q3.PDF', 'report-q3.pdf'],
    ['notes', 'notes.bin'],
  ])('%s becomes %s', (input, expected) => {
    names.push(uploadName(input));
    expect(names).toEqual([expected]);
  });

  it.skip('keeps accented letters', () => {
    expect(uploadName('Café.txt')).toBe('café.txt');
  });
});

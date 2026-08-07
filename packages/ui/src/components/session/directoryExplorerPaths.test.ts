import { describe, expect, test } from 'bun:test';

import { displayPathToAbsolutePath } from './directoryExplorerPaths';

const WINDOWS_HOME = 'C:\\Users\\Bohdan Triapitsyn';
const POSIX_HOME = '/home/yulia';

describe('directory explorer path entry', () => {
  test('expands the tilde the field opens with', () => {
    expect(displayPathToAbsolutePath('~', WINDOWS_HOME)).toBe(WINDOWS_HOME);
    expect(displayPathToAbsolutePath('~/projects/openchamber', POSIX_HOME)).toBe('/home/yulia/projects/openchamber');
  });

  test('does not hang a pasted absolute path off the home directory', () => {
    // The caret sits after the `~/` the field opens with, so a paste lands behind it.
    // Joining the two produces a path nobody meant, which the dialog then offers to
    // create — this is how an empty directory ended up in a home folder.
    const pasted = 'C:\\Users\\Bohdan Triapitsyn\\AppData\\Local\\Temp\\openchamber-functional-project';
    expect(displayPathToAbsolutePath('~/' + pasted, WINDOWS_HOME)).toBe(pasted);
    expect(displayPathToAbsolutePath('~//home/yulia/projects/demo', POSIX_HOME)).toBe('/home/yulia/projects/demo');
    expect(displayPathToAbsolutePath('~/\\\\fileserver\\projects', WINDOWS_HOME)).toBe('\\\\fileserver\\projects');
  });

  test('still treats an ordinary relative remainder as relative to home', () => {
    // A bare drive letter is not a path, and a name that merely contains a colon is a
    // directory name — neither may be mistaken for something already rooted.
    expect(displayPathToAbsolutePath('~/projects', WINDOWS_HOME)).toBe('C:\\Users\\Bohdan Triapitsyn/projects');
    expect(displayPathToAbsolutePath('~/notes: draft', POSIX_HOME)).toBe('/home/yulia/notes: draft');
  });

  test('leaves a path typed without the tilde alone', () => {
    expect(displayPathToAbsolutePath('D:\\work\\repo', WINDOWS_HOME)).toBe('D:\\work\\repo');
    expect(displayPathToAbsolutePath('  /srv/repo  ', POSIX_HOME)).toBe('/srv/repo');
  });
});

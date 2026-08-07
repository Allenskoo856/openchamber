/** A drive path, a UNC share, or a POSIX absolute path — anything already rooted. */
export const isAbsolutePath = (value: string): boolean => /^([a-zA-Z]:[\\/]|[\\/][\\/]|\/)/.test(value);

/** Resolves what the path field shows into a path the host can open. */
export const displayPathToAbsolutePath = (value: string, homeDirectory: string): string => {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDirectory;
  if (trimmed.startsWith('~/')) {
    // The field opens at `~/` with the caret after it, so pasting an absolute path lands
    // behind the tilde and would otherwise be joined onto the home directory. The result
    // is a path nobody meant, and because it does not exist the dialog offers to create
    // it — which is how empty directories end up in a home folder. A rooted remainder
    // replaces the tilde instead of hanging off it.
    const remainder = trimmed.slice(2);
    if (isAbsolutePath(remainder)) return remainder;
    return `${homeDirectory}${trimmed.slice(1)}`;
  }
  return trimmed;
};

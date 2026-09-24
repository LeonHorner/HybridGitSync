/**
 * .gitattributes parser and matcher (Git LFS filter detection).
 *
 * Pattern syntax follows gitignore globs with gitattributes differences:
 * - No `!` negation lines (unset attributes use `-attr` instead)
 * - A directory pattern `foo/` matches the directory path only, NOT its
 *   contents — use `foo/**` to recurse
 * - Last matching rule wins (call addRules root-first, deeper files later)
 */

export interface GitAttrRule {
  pattern: string;
  regex: RegExp;
  /** attr name -> value string, or null for `-attr`/`!attr` unset, true for bare `attr` */
  attrs: Record<string, string | true | null>;
}

export function parseGitAttributes(content: string, dir: string = ''): GitAttrRule[] {
  const rules: GitAttrRule[] = [];
  const lines = content.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // gitattributes has no `!` negation lines
    if (trimmed.startsWith('!')) continue;

    const parts = trimmed.split(/\s+/);
    const pattern = parts[0];
    if (!pattern) continue;

    const attrs: Record<string, string | true | null> = {};
    for (const token of parts.slice(1)) {
      if (token.startsWith('-') || token.startsWith('!')) {
        attrs[token.slice(1)] = null;
      } else if (token.includes('=')) {
        const eq = token.indexOf('=');
        attrs[token.slice(0, eq)] = token.slice(eq + 1);
      } else {
        attrs[token] = true;
      }
    }

    // Resolve pattern relative to the directory containing this file
    let fullPattern = pattern;
    if (dir) {
      fullPattern = pattern.startsWith('/')
        ? `${dir}${pattern}`
        : `${dir}/${pattern}`;
    }

    rules.push({
      pattern: fullPattern,
      regex: patternToRegex(fullPattern),
      attrs,
    });
  }

  return rules;
}

export class GitAttributesRules {
  private rules: GitAttrRule[] = [];
  private lfsPatternSeen = false;

  /**
   * Parse one .gitattributes file. `dir` is the directory containing it
   * ('' for root). Deeper files must be added after shallower ones
   * (last-match-wins across the stack).
   */
  addRules(content: string, dir: string = ''): void {
    const parsed = parseGitAttributes(content, dir);
    for (const rule of parsed) {
      if (rule.attrs['filter'] === 'lfs') {
        this.lfsPatternSeen = true;
      }
    }
    this.rules.push(...parsed);
  }

  /** True if any rule sets filter=lfs (conservative "repo uses LFS" signal). */
  hasLfsPatterns(): boolean {
    return this.lfsPatternSeen;
  }

  /**
   * True if `path` is LFS-tracked. Last matching rule wins: `filter=lfs`
   * sets, `-filter` / `!filter` unsets.
   */
  isLfsTracked(path: string): boolean {
    let filter: string | true | null | undefined;

    for (const rule of this.rules) {
      if (rule.regex.test(path)) {
        if ('filter' in rule.attrs) {
          filter = rule.attrs['filter'];
        }
      }
    }

    return filter === 'lfs';
  }
}

/**
 * Convert a gitattributes/gitignore-style pattern to RegExp.
 * Mirrors GitignoreRules.patternToRegex with dir-only matching tightened
 * to the directory path itself (gitattributes does not recurse).
 */
function patternToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  let work = pattern;

  // Leading '/' anchors to root
  if (work.startsWith('/')) {
    work = work.slice(1);
    regexStr += '^';
  }

  // Directory-only patterns match the directory path only, not contents
  const dirOnly = work.endsWith('/');
  if (dirOnly) {
    work = work.slice(0, -1);
  }

  const hasSlash = work.includes('/');
  if (!regexStr) {
    regexStr += hasSlash ? '^' : '(^|/)';
  }

  while (i < work.length) {
    const char = work[i];

    if (char === '*') {
      if (work[i + 1] === '*') {
        if (work[i + 2] === '/') {
          regexStr += '(.*/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        regexStr += '[^/]*';
        i++;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i++;
    } else if (char === '[') {
      const end = work.indexOf(']', i + 1);
      if (end > -1) {
        regexStr += work.substring(i, end + 1);
        i = end + 1;
      } else {
        regexStr += '\\[';
        i++;
      }
    } else {
      if (/[.+^${}()|\\]/.test(char)) {
        regexStr += '\\';
      }
      regexStr += char;
      i++;
    }
  }

  // dirOnly: match the directory path exactly; otherwise allow descendants
  regexStr += dirOnly ? '/?$' : '(/.*)?$';

  return new RegExp(regexStr);
}

/**
 * Desktop-only Node typings.
 *
 * Obsidian's review environment (mobile-first) does not load @types/node, so
 * any use of Node built-ins there collapses to `any` and triggers the whole
 * no-unsafe-* family. Declaring exactly the Node surface this plugin uses
 * keeps local typecheck and the review environment consistent. tsconfig sets
 * "types": [] so @types/node is never pulled in globally.
 */
declare module 'child_process' {
  export interface ExecFileOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    maxBuffer?: number;
  }

  export type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: ExecFileCallback
  ): void;

  export function execFile(
    file: string,
    args: readonly string[],
    callback: ExecFileCallback
  ): void;
}

declare function require(moduleName: 'child_process'): typeof import('child_process');
declare function require(moduleName: string): unknown;

declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
};

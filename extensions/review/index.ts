/**
 * Review extension entry point.
 *
 * Re-exports the single-file entry so the extension installs as a directory
 * (`review/` symlink). Relative imports from review.ts (e.g.
 * `./review-config.ts`) then resolve inside the real directory, which a
 * single-file symlink (`review.ts`) cannot provide — pi loads extensions via
 * their configured path and resolves relative imports against that path's
 * directory, so file symlinks with sibling modules break at load time.
 */
export { default } from "./review.ts";

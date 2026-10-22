/**
 * The `scripts/*.mjs` helpers are shipped as plain JS with no type declarations.
 * Importing them from a `.test.ts` used to be an implicit `any`; `strict` turns
 * that into an error. Declaring the extension keeps the shim in one place
 * instead of adding a `.d.ts` next to every script.
 */
declare module "*.mjs";

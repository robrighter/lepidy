/**
 * The account object's address, in a module with no imports.
 *
 * `accounts.ts` reaches Argon2id's WebAssembly, which the Next.js bundler cannot
 * compile. Anything in the Next graph that needs to *address* the object must
 * import this constant and the class as a type only, so the hasher never follows
 * it across the boundary.
 */
export const ACCOUNTS_OBJECT_NAME = "control";

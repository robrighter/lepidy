declare module "argon2id/lib/setup.js" {
  export interface Argon2idParams {
    password: Uint8Array;
    salt: Uint8Array;
    parallelism: number;
    passes: number;
    memorySize: number;
    tagLength: number;
    ad?: Uint8Array;
    secret?: Uint8Array;
  }

  export type computeHash = (params: Argon2idParams) => Uint8Array;

  export default function setupArgon2id(
    simd: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>,
    nonSimd: (imports: WebAssembly.Imports) => Promise<WebAssembly.WebAssemblyInstantiatedSource>,
  ): Promise<computeHash>;
}

declare module "argon2id/dist/no-simd.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "argon2id/dist/simd.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

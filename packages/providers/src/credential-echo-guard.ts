import { ProviderError } from "./types.js";

export class CredentialEchoGuard {
  readonly #credential: Uint8Array;
  #tail = new Uint8Array();

  constructor(credential: string) {
    this.#credential = new TextEncoder().encode(credential);
  }

  inspect(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.#tail.byteLength + chunk.byteLength);
    joined.set(this.#tail);
    joined.set(chunk, this.#tail.byteLength);
    if (this.#contains(joined)) {
      this.#tail = new Uint8Array();
      throw new ProviderError(
        "invalid_response",
        "Provider response contained credential material",
        false,
      );
    }
    const keep = Math.min(this.#credential.byteLength - 1, joined.byteLength);
    this.#tail = joined.slice(joined.byteLength - keep);
  }

  #contains(value: Uint8Array): boolean {
    const limit = value.byteLength - this.#credential.byteLength;
    for (let start = 0; start <= limit; start += 1) {
      let matches = true;
      for (let index = 0; index < this.#credential.byteLength; index += 1) {
        if (value[start + index] !== this.#credential[index]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
    return false;
  }
}

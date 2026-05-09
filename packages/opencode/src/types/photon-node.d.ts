declare module "@silvia-odwyer/photon-node" {
  export class PhotonImage {
    constructor(raw_pixels: Uint8Array, width: number, height: number)
    static new_from_byteslice(byteslice: Uint8Array): PhotonImage
    get_width(): number
    get_height(): number
    get_bytes(): Uint8Array
    get_bytes_jpeg(quality: number): Uint8Array
    free(): void
  }

  export const SamplingFilter: {
    readonly Lanczos3: number
  }

  export function resize(img: PhotonImage, width: number, height: number, filter: number): PhotonImage
}

declare module "@silvia-odwyer/photon-node/photon_rs_bg.wasm" {
  const wasm_path: string
  export default wasm_path
}

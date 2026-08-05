import type { RendererFormat } from "./OutputJob";

export interface RawBlock {
  type: "raw";
  format: "plain";
  data: string;
}

export interface RenderedOutput {
  rendererVersion: number;
  format: RendererFormat;
  blocks: RawBlock[];
}

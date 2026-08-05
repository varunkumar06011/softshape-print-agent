import type { TableSwapPrintInput } from "../../models/TableSwapOutput";
import type { RenderedOutput } from "../../models/RenderedOutput";
import { RENDERER_VERSION } from "./constants";
import {
  INIT, CENTER, LEFT, BOLD_ON, BOLD_OFF,
  SIZE_2X, CUT,
} from "./constants";
import { separator } from "./helpers";

export function renderTableSwap(input: TableSwapPrintInput): RenderedOutput {
  const { fromTableNumber, toTableNumber, swappedBy, timestamp } = input;

  const cmds: string[] = [
    INIT,
    SIZE_2X,
    CENTER,
    BOLD_ON,
    'TABLE MOVED\n',
    BOLD_OFF,
    separator(),
    LEFT,
    `From  : Table ${fromTableNumber}\n`,
    `To    : Table ${toTableNumber}\n`,
    `By    : ${swappedBy || 'Staff'}\n`,
    `Time  : ${new Date(timestamp || Date.now()).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}\n`,
    separator(),
    CENTER,
    BOLD_ON,
    'Session transferred\n',
    BOLD_OFF,
    '\n\n',
    CUT,
  ];

  return { rendererVersion: RENDERER_VERSION, format: "escpos", blocks: [{ type: "raw", format: "plain", data: cmds.join('') }] };
}

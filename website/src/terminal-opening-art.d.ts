// The build compiles the CLI's actual pure renderer into this module.
export interface TerminalOpeningCell { readonly ch: string; readonly light: number }
export declare function renderTerminalOpeningArt(width: number, height: number, frame?: number): readonly (readonly TerminalOpeningCell[])[];

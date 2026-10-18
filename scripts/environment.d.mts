// Types for the plain-JavaScript environment resolver ({§environment-layers}).
export interface LayerOptions { readonly operatorFile: string }
export function gateProfile(root?: string): string;
export function realModelLayers(root?: string, options?: LayerOptions): string[];
export function floorModule(root?: string): string;
export function realModelNodeFlags(root?: string, options?: LayerOptions): string[];
export function applyRealModelEnvironment(root?: string, options?: { readonly operatorFile?: string; readonly floor?: boolean }): Promise<void>;

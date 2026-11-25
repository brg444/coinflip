export type CompileDiagnostic = {
  severity: string;
  code?: string;
  file?: string;
  start?: { line: number; column: number };
  message: string;
};

export function forTwoKeyOperator<T extends Record<string, unknown>>(artifact: T): T;
export function loadContractSources(dir: string): Record<string, string>;
export function compileContract(
  entry: string,
  dir: string,
): Promise<{ artifact: Record<string, unknown> | null; diagnostics: CompileDiagnostic[] }>;

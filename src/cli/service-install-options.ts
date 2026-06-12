export interface ServiceInstallCliOptions {
  poll?: boolean;
  indexNow?: boolean;
  bootstrapBatchSize?: number;
  maxAnalysisMemoryMb?: number;
}

export interface NormalizedServiceInstallOptions {
  indexNow: boolean;
  bootstrapBatchSize?: number;
  maxAnalysisMemoryMb?: number;
  extraArgs?: string[];
}

export function normalizeServiceInstallOptions(options: ServiceInstallCliOptions): NormalizedServiceInstallOptions {
  assertPositive("--bootstrap-batch-size", options.bootstrapBatchSize);
  assertPositive("--max-analysis-memory-mb", options.maxAnalysisMemoryMb);
  const args: string[] = [];
  if (options.poll) args.push("--poll");
  if (options.bootstrapBatchSize !== undefined) args.push("--max-batch-files", String(options.bootstrapBatchSize));
  if (options.maxAnalysisMemoryMb !== undefined) args.push("--max-analysis-memory-mb", String(options.maxAnalysisMemoryMb));
  return {
    indexNow: options.indexNow === true,
    bootstrapBatchSize: options.bootstrapBatchSize,
    maxAnalysisMemoryMb: options.maxAnalysisMemoryMb,
    extraArgs: args.length > 0 ? args : undefined
  };
}

function assertPositive(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${name} must be a positive number.`);
  }
}

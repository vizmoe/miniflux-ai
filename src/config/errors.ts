export class ConfigurationError extends Error {
  constructor(public readonly paths: string[]) {
    super(`Invalid configuration: ${paths.join(', ')}`);
  }
}

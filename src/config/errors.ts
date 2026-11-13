export class ConfigurationError extends Error {
  paths;
  constructor(paths: string[]) {
    super(`Invalid configuration: ${paths.join(', ')}`);
    this.paths = paths;
  }
}

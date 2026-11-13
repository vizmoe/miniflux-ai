import { ConfigurationError } from './errors.js';
export function argumentsOf(args = process.argv.slice(2)) {
  let path = './config.yaml';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && args[i + 1] && !args[i + 1].startsWith('--'))
      path = args[++i];
    else throw new ConfigurationError(['command_line']);
  }
  return { path };
}

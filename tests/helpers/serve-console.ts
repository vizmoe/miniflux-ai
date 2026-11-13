import { startHarness } from './harness.js';
const harness = await startHarness(18801);
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void harness.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });

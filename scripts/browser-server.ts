import 'dotenv/config';
import { spawn } from 'node:child_process';
const children = ['services/api/src/index.ts', 'services/worker/src/index.ts'].map((file) =>
  spawn(process.execPath, ['--import', 'tsx', file], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '4310',
      PAYSTACK_SECRET_KEY: '',
      PRIVY_APP_ID: '',
      PRIVY_APP_SECRET: '',
      PRIVY_CLIENT_ID: '',
      PRIVY_VERIFICATION_KEY: '',
      STELLAR_TESTNET_ISSUER: '',
      STELLAR_TESTNET_TREASURY_SECRET: '',
    },
  }),
);
let closing = false;
const stop = () => {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children)
  child.on('exit', (code) => {
    if (!closing) {
      process.exitCode = code ?? 1;
      stop();
    }
  });

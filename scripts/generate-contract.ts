import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';
import { buildApi } from '../services/api/src/app.js';
import { pool } from '../packages/database/src/index.js';
const app = await buildApi({ serveWeb: false });
try {
  const spec = app.swagger();
  const files: [string, string][] = [
    ['specs/openapi/microsendr.json', JSON.stringify(spec, null, 2) + '\n'],
    [
      'sdks/typescript/src/generated.ts',
      astToString(await openapiTS(spec as Parameters<typeof openapiTS>[0])),
    ],
  ];
  for (const [path, content] of files) {
    if (process.argv.includes('--check')) {
      if ((await readFile(path, 'utf8')) !== content)
        throw new Error(`${path} is stale; run pnpm generate`);
    } else {
      await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await writeFile(path, content);
    }
  }
  console.log(
    process.argv.includes('--check')
      ? 'Contract and SDK types are current'
      : 'Generated OpenAPI and TypeScript types',
  );
} finally {
  await app.close();
  await pool.end();
}

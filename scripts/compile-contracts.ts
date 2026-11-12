/**
 * Compiles contracts/*.sol with solc and writes contracts/artifacts/<Name>.json
 * (ABI, bytecode and the exact compiler input, so the source can be verified on the
 * QIE explorer). Usage: node --import tsx scripts/compile-contracts.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const solc = createRequire(import.meta.url)('solc');
// QIE Mainnet runs the Paris rule set; newer opcodes (PUSH0) are left out.
const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } };
const files = [
  ...readdirSync('contracts').filter((f) => f.endsWith('.sol')).map((f) => `contracts/${f}`),
  ...readdirSync('contracts/test').filter((f) => f.endsWith('.sol')).map((f) => `contracts/test/${f}`),
];
const input = { language: 'Solidity', sources: Object.fromEntries(files.map((f) => [f, { content: readFileSync(f, 'utf8') }])), settings };
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
for (const e of output.errors ?? []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
mkdirSync('contracts/artifacts', { recursive: true });
for (const [file, contracts] of Object.entries(output.contracts as Record<string, Record<string, any>>)) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces
    const single = { language: 'Solidity', sources: { [file]: input.sources[file] }, settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } } };
    writeFileSync(`contracts/artifacts/${name}.json`, JSON.stringify({
      contractName: name, sourceName: file, compiler: solc.version(), abi: c.abi,
      bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`, standardJsonInput: single,
    }, null, 2) + '\n');
    console.log(`compiled ${name} (${c.evm.deployedBytecode.object.length / 2} bytes)`);
  }
}

/**
 * Deploys MicrosendrPay to QIE Mainnet and records the address.
 *
 *   DEPLOYER_PRIVATE_KEY=0x… BILLS_TREASURY_ADDRESS=0x… OPERATOR_ADDRESS=0x… \
 *     node --import tsx scripts/deploy-microsendr-pay.ts            # dry run: prints the plan
 *   … node --import tsx scripts/deploy-microsendr-pay.ts --deploy   # deploys
 *
 * The deployer becomes the contract owner. OPERATOR_ADDRESS is the account whose private key
 * the API and worker use as OPERATOR_PRIVATE_KEY; it needs a little QIE for gas. Never prints keys.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { QIE_QUSDC_CONTRACT } from '../packages/qie/src/index.js';

const rpcUrl = process.env.QIE_RPC_URL || 'https://rpc1mainnet.qie.digital/';
const chain = { id: 1990, name: 'QIE Mainnet', nativeCurrency: { name: 'QIE', symbol: 'QIE', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
const treasury = process.env.BILLS_TREASURY_ADDRESS, operator = process.env.OPERATOR_ADDRESS;
if (!key || !/^0x[a-fA-F0-9]{64}$/.test(key)) throw new Error('Set DEPLOYER_PRIVATE_KEY');
if (!treasury || !operator) throw new Error('Set BILLS_TREASURY_ADDRESS (where settled payments go) and OPERATOR_ADDRESS');
const artifact = JSON.parse(readFileSync('contracts/artifacts/MicrosendrPay.json', 'utf8')) as { abi: Abi; bytecode: Hex; compiler: string };
const account = privateKeyToAccount(key);
const reader = createPublicClient({ chain, transport: http(rpcUrl) });
const args = [getAddress(QIE_QUSDC_CONTRACT), getAddress(treasury), getAddress(operator)] as const;
console.log(`Network:   QIE Mainnet (chain ${await reader.getChainId()})`);
console.log(`Deployer:  ${account.address} (${formatEther(await reader.getBalance({ address: account.address }))} QIE) becomes owner`);
console.log(`Token:     ${args[0]} (QUSDC)\nTreasury:  ${args[1]}\nOperator:  ${args[2]}\nCompiler:  solc ${artifact.compiler}`);
if (!process.argv.includes('--deploy')) { console.log('\nDry run. Add --deploy to deploy.'); process.exit(0); }
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
console.log(`\nDeploying: ${hash}`);
const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment failed');
mkdirSync('contracts/deployments', { recursive: true });
const record = { network: 'qie-mainnet', chainId: 1990, address: receipt.contractAddress, transactionHash: hash, block: Number(receipt.blockNumber),
  constructorArgs: args, owner: account.address, compiler: artifact.compiler, deployedAt: new Date().toISOString() };
writeFileSync('contracts/deployments/qie-mainnet.json', JSON.stringify(record, null, 2) + '\n');
console.log(`Deployed MicrosendrPay at ${receipt.contractAddress}`);
console.log(`Explorer:  https://mainnet.qie.digital/address/${receipt.contractAddress}`);
console.log('Next: set MICROSENDR_PAY_ADDRESS and OPERATOR_PRIVATE_KEY on api and worker, and verify the source (contracts/README.md).');

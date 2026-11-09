import { buildApi } from './app.js';
import { pool } from '../../../packages/database/src/index.js';
// KORA_RATE_LIMIT_MAX raises the general per-client limit (requests a minute) for test servers.
const app=await buildApi({logger:true,rateLimitMax:Number(process.env.KORA_RATE_LIMIT_MAX)||undefined});
try {await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4310)});}
catch {app.log.error('Roots API could not start');await app.close();await pool.end();process.exitCode=1;}
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();await pool.end();}
process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});

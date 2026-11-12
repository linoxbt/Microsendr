import { buildApi } from './app.js';
import { pool } from '../../../packages/database/src/index.js';
import { configReport, fatalConfigProblems } from './config.js';
// Without the auth secret, codes and PINs would be hashed without a server-side key:
// refuse to start rather than run weakened.
const fatal=fatalConfigProblems();
if(fatal.length){console.error(JSON.stringify({level:'fatal',msg:'Microsendr API refuses to start: missing required settings',missing:fatal}));await pool.end();process.exit(1);}
// KORA_RATE_LIMIT_MAX raises the general per-client limit (requests a minute) for test servers.
const app=await buildApi({logger:true,rateLimitMax:Number(process.env.KORA_RATE_LIMIT_MAX)||undefined});
// Names only: a missing setting is visible at deploy time.
const config=configReport();
if(!config.ready)app.log.error({missing:config.missing},'Microsendr API is missing required settings');
if(config.optional.length)app.log.warn({not_configured:config.optional},'Optional features are not configured');
try {await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??4310)});}
catch {app.log.error('Microsendr API could not start');await app.close();await pool.end();process.exitCode=1;}
let closing=false;
async function close(){if(closing)return;closing=true;await app.close();await pool.end();}
process.on('SIGINT',()=>{void close();});process.on('SIGTERM',()=>{void close();});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApi } from '../services/api/src/app.js';
import { PaystackClient } from '../connectors/paystack/src/index.js';
import { id, pool } from '../packages/database/src/index.js';
import { invariantReport } from '../packages/ledger/src/index.js';

const origin = 'http://127.0.0.1:4310';
const codes = new Map<string,string>();
const collections = new Map<string,{ amount: string; email: string; status: string }>();
const payouts = new Map<string,{ amount: string; recipient: string; status: string }>();
let collectionPosts = 0, payoutPosts = 0, timeoutNextPayout = false;
const data = (value: unknown) => new Response(JSON.stringify({status:true,data:value}),{status:200});
const paystack = new PaystackClient({ secretKey:'sk_test_personalpaystack123456789', fetch: async (url, init) => {
  const path = new URL(String(url));
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (path.pathname==='/transaction/initialize') {
    collectionPosts++;
    collections.set(body.reference,{amount:String(body.amount),email:body.email,status:'success'});
    assert.equal(body.currency,'NGN');
    assert.match(body.callback_url,/\/personal\/money$/);
    return data({reference:body.reference,authorization_url:`https://checkout.paystack.com/${body.reference}`,access_code:'test-code'});
  }
  if (path.pathname.startsWith('/transaction/verify/')) {
    const reference=path.pathname.split('/').at(-1)!;
    const row=collections.get(reference)!;
    return data({id:'123456789',domain:'test',reference,currency:'NGN',amount:row.amount,status:row.status,fees:'1500',customer:{email:row.email}});
  }
  if (path.pathname==='/bank') return data([{name:'Test Bank',code:'044',active:true,currency:'NGN'}]);
  if (path.pathname==='/bank/resolve') return data({account_number:path.searchParams.get('account_number'),account_name:'Test Recipient'});
  if (path.pathname==='/transferrecipient') return data({recipient_code:'RCP_personaltest123',domain:'test',currency:'NGN',type:'nuban',active:true,details:{account_number:body.account_number,bank_code:body.bank_code}});
  if (path.pathname==='/transfer' && init?.method==='POST') {
    payoutPosts++;
    payouts.set(body.reference,{amount:String(body.amount),recipient:body.recipient,status:'success'});
    if (timeoutNextPayout) { timeoutNextPayout=false; throw new Error('Network timeout after submission'); }
    return data({domain:'test',reference:body.reference,currency:'NGN',amount:body.amount});
  }
  if (path.pathname.startsWith('/transfer/verify/')) {
    const reference=path.pathname.split('/').at(-1)!;
    const row=payouts.get(reference)!;
    return data({id:'234567890',domain:'test',reference,currency:'NGN',amount:row.amount,status:row.status,fee_charged:'500',recipient:{recipient_code:row.recipient,domain:'test',currency:'NGN',details:{bank_code:'044',account_number:'0123456789'}}});
  }
  throw new Error(`Unexpected Paystack test request: ${path.pathname}`);
} });
const app=await buildApi({serveWeb:false,rateLimitMax:10000,paystackClient:paystack,personal:{codeSecret:'paystack-test-secret',sendCode:async (email,code)=>{codes.set(email,code);}}});
after(async()=>{await app.close();await pool.end();});
async function login() {
  const email=`${id('paystackpersonal')}@example.test`;
  await pool.query('INSERT INTO personal_users(id,email) VALUES($1,$2) ON CONFLICT(email) DO NOTHING',[id('usr'),email]);
  const start=await app.inject({method:'POST',url:'/personal/api/auth/start',headers:{origin},payload:{email}});
  assert.equal(start.statusCode,200,start.body);
  const verify=await app.inject({method:'POST',url:'/personal/api/auth/verify',headers:{origin},payload:{challenge_id:start.json().challenge_id,code:codes.get(email)}});
  assert.equal(verify.statusCode,200,verify.body);
  return {email,cookie:String(verify.headers['set-cookie']).split(';')[0],csrf:verify.json().csrf_token as string};
}
function post(auth:{cookie:string;csrf:string},url:string,payload:object,key?:string) {
  return app.inject({method:'POST',url,headers:{origin,cookie:auth.cookie,'x-kora-csrf':auth.csrf,...(key?{'idempotency-key':key}:{})},payload});
}
const get=(auth:{cookie:string},url:string)=>app.inject({url,headers:{cookie:auth.cookie}});

test('Personal Paystack test collections and withdrawals verify once, preserve unknowns, and balance journals',async()=>{
  const auth=await login();
  assert.equal((await get(auth,'/personal/api/paystack/config')).json().configured,true);
  assert.equal((await get(auth,'/personal/api/paystack/banks')).statusCode,403);
  assert.equal((await post(auth,'/personal/api/sandbox/verify',{residence_country:'NG',acknowledge_simulation:true})).statusCode,200);
  assert.equal((await post(auth,'/personal/api/sandbox/fund',{})).statusCode,200);
  assert.equal((await get(auth,'/personal/api/paystack/banks')).json().data[0].code,'044');

  const collectionKey=id('key');
  const collection=await post(auth,'/personal/api/paystack/collections',{amount_minor:'100000'},collectionKey);
  assert.equal(collection.statusCode,200,collection.body);
  assert.equal(collection.json().status,'checkout_ready');
  assert.equal((await post(auth,'/personal/api/paystack/collections',{amount_minor:'100000'},collectionKey)).json().id,collection.json().id);
  assert.equal(collectionPosts,1);
  assert.equal((await post(auth,'/personal/api/paystack/collections',{amount_minor:'100001'},collectionKey)).statusCode,409);
  const collectionPath=`/personal/api/paystack/collections/${collection.json().id}/verify`;
  const verifiedCollection=await post(auth,collectionPath,{});
  assert.equal(verifiedCollection.statusCode,200,verifiedCollection.body);
  assert.equal(verifiedCollection.json().status,'completed');
  assert.equal((await post(auth,collectionPath,{})).json().status,'completed');
  assert.equal((await get(auth,'/personal/api/home')).json().balance.available_minor,'10098500');

  const resolved=await post(auth,'/personal/api/paystack/resolve',{bank_code:'044',account_number:'0123456789'});
  assert.equal(resolved.json().account_name,'Test Recipient');
  const bank={bank_code:'044',account_number:'0123456789'};
  const payoutKey=id('key');
  const payout=await post(auth,'/personal/api/paystack/withdrawals',{...bank,amount_minor:'200000'},payoutKey);
  assert.equal(payout.statusCode,200,payout.body);
  assert.equal(payout.json().status,'pending');
  assert.equal((await post(auth,'/personal/api/paystack/withdrawals',{...bank,amount_minor:'200000'},payoutKey)).json().id,payout.json().id);
  assert.equal(payoutPosts,1);
  const payoutPath=`/personal/api/paystack/withdrawals/${payout.json().id}/verify`;
  assert.equal((await post(auth,payoutPath,{})).json().status,'completed');
  assert.equal((await post(auth,payoutPath,{})).json().status,'completed');
  assert.equal((await get(auth,'/personal/api/home')).json().balance.available_minor,'9898500');

  const failed=await post(auth,'/personal/api/paystack/withdrawals',{...bank,amount_minor:'25000'},id('key'));
  assert.equal(failed.statusCode,200,failed.body);
  const failedReference=(await pool.query('SELECT reference FROM personal_paystack_operations WHERE id=$1',[failed.json().id])).rows[0].reference;
  payouts.get(failedReference)!.status='failed';
  assert.equal((await post(auth,`/personal/api/paystack/withdrawals/${failed.json().id}/verify`,{})).json().status,'failed');
  assert.equal((await get(auth,'/personal/api/home')).json().balance.available_minor,'9898500');

  timeoutNextPayout=true;
  const unknown=await post(auth,'/personal/api/paystack/withdrawals',{...bank,amount_minor:'10000'},id('key'));
  assert.equal(unknown.statusCode,200,unknown.body);
  assert.equal(unknown.json().status,'unknown');
  assert.equal((await get(auth,'/personal/api/home')).json().balance.available_minor,'9888500');
  assert.equal((await post(auth,`/personal/api/paystack/withdrawals/${unknown.json().id}/verify`,{})).json().status,'completed');
  assert.equal((await get(auth,'/personal/api/home')).json().balance.available_minor,'9888500');
  assert.equal(payoutPosts,3);
  const completedReference=(await pool.query('SELECT reference FROM personal_paystack_operations WHERE id=$1',[payout.json().id])).rows[0].reference;
  payouts.get(completedReference)!.status='reversed';
  assert.equal((await post(auth,payoutPath,{})).json().status,'returned');
  assert.equal((await post(auth,payoutPath,{})).json().status,'returned');
  assert.equal((await get(auth,'/personal/api/home')).json().balance.available_minor,'10088500');
  assert.deepEqual(await invariantReport(),{balanced:true,nonnegative:true,no_empty_journals:true,violations:[]});
});

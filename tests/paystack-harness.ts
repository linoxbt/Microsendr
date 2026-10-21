import { createServer } from 'node:http';
import { randomBytes, createHmac } from 'node:crypto';
import { PaystackClient, PaystackTestConnector } from '../connectors/paystack/src/index.js';

// A local transport harness, never imported by production services. Wire payloads
// follow Paystack's documented API; no external requests or provider keys.
export async function paystackHarness() {
  const secretKey = `sk_test_${randomBytes(24).toString('hex')}`;
  const recipients = new Map<string, Record<string, any>>(),
    transfers = new Map<string, Record<string, any>>(),
    charges = new Map<string, Record<string, any>>();
  const statements: Record<string, any>[] = [];
  let transferPosts = 0,
    collectionPosts = 0,
    sequence = Number.parseInt(randomBytes(6).toString('hex'), 16);
  const control = {
    transferStatus: 'success',
    transferFee: '0',
    dropTransfer: false,
    dropCollection: false,
    verifyUnavailable: false,
    transferPatch: {} as Record<string, unknown>,
    chargePatch: {} as Record<string, unknown>,
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${secretKey}`) {
      res.writeHead(401).end(JSON.stringify({ status: false, message: 'Unauthorized' }));
      return;
    }
    const url = new URL(req.url!, 'http://harness'),
      parts = [];
    for await (const part of req) parts.push(part);
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(Buffer.concat(parts).toString() || '{}');
    } catch {}
    const send = (data: unknown, status = 200, message = 'OK') => {
      res
        .writeHead(status, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: status === 200, message, data }));
    };
    if (url.pathname === '/bank')
      return send([{ name: 'Test Bank', code: '058', active: true, currency: 'NGN' }]);
    if (url.pathname === '/bank/resolve')
      return send({
        account_number: url.searchParams.get('account_number'),
        account_name: 'KORA TEST BENEFICIARY',
      });
    if (url.pathname === '/balance') return send([{ currency: 'NGN', balance: 100000000 }]);
    if (url.pathname === '/balance/ledger') {
      const perPage = Number(url.searchParams.get('perPage') ?? 50), page = Number(url.searchParams.get('page') ?? 1);
      return send(statements.slice((page - 1) * perPage, page * perPage));
    }
    if (url.pathname === '/transferrecipient') {
      const key = `${body.bank_code}:${body.account_number}`;
      let recipient = recipients.get(key);
      if (!recipient) {
        recipient = {
          recipient_code: `RCP_test${++sequence}`,
          domain: 'test',
          currency: 'NGN',
          type: 'nuban',
          active: true,
          details: { bank_code: body.bank_code, account_number: body.account_number },
        };
        recipients.set(key, recipient);
      }
      return send(recipient);
    }
    if (url.pathname === '/transfer') {
      transferPosts++;
      let transfer = transfers.get(body.reference);
      if (!transfer) {
        const recipient = [...recipients.values()].find((r) => r.recipient_code === body.recipient);
        transfer = {
          id: String(++sequence),
          domain: 'test',
          currency: body.currency,
          reference: body.reference,
          amount: String(body.amount),
          status: control.transferStatus,
          fee_charged: control.transferFee,
          recipient,
        };
        transfers.set(body.reference, transfer);
        if (transfer.status === 'success')
          statements.push({
            id: String(++sequence),
            domain: 'test',
            currency: 'NGN',
            difference: (-BigInt(transfer.amount) - BigInt(transfer.fee_charged)).toString(),
            model_responsible: 'Transfer',
            model_row: transfer.id,
            createdAt: new Date().toISOString(),
          });
      }
      if (control.dropTransfer) {
        control.dropTransfer = false;
        req.socket.destroy();
        return;
      }
      return send({ ...transfer, status: 'pending' });
    }
    if (url.pathname.startsWith('/transfer/verify/')) {
      if (control.verifyUnavailable) return send(null, 503, 'Unavailable');
      const transfer = transfers.get(decodeURIComponent(url.pathname.split('/').at(-1)!));
      return transfer
        ? send({ ...transfer, ...control.transferPatch })
        : send(null, 404, 'Transfer not found');
    }
    if (url.pathname === '/transaction/initialize') {
      collectionPosts++;
      if (!charges.has(body.reference))
        charges.set(body.reference, {
          id: String(++sequence),
          domain: 'test',
          currency: body.currency,
          reference: body.reference,
          amount: String(body.amount),
          status: 'pending',
          fees: '100',
          customer: { email: body.email },
        });
      if (control.dropCollection) {
        control.dropCollection = false;
        req.socket.destroy();
        return;
      }
      return send({
        reference: body.reference,
        authorization_url: `https://checkout.paystack.com/${body.reference}`,
        access_code: `test_${sequence}`,
      });
    }
    if (url.pathname.startsWith('/transaction/verify/')) {
      if (control.verifyUnavailable) return send(null, 503, 'Unavailable');
      const charge = charges.get(decodeURIComponent(url.pathname.split('/').at(-1)!));
      return charge
        ? send({ ...charge, ...control.chargePatch })
        : send(null, 404, 'Transaction not found');
    }
    send(null, 404, 'Not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Harness did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const transport = (async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.paystack.co') throw new Error('Unexpected provider origin');
    return fetch(`${origin}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
  const client = new PaystackClient({ secretKey, fetch: transport, timeoutMs: 1000 }),
    connector = new PaystackTestConnector(client);
  return {
    client,
    connector,
    origin,
    secretKey,
    control,
    transfers,
    charges,
    statements,
    counts: () => ({ transferPosts, collectionPosts }),
    sign: (raw: string) => createHmac('sha512', secretKey).update(raw).digest('hex'),
    complete: (ref: string) => {
      const c = charges.get(ref)!;
      c.status = 'success';
      statements.push({
        id: String(++sequence),
        domain: 'test',
        currency: 'NGN',
        difference: (BigInt(c.amount) - BigInt(c.fees)).toString(),
        model_responsible: 'Transaction',
        model_row: c.id,
        createdAt: new Date().toISOString(),
      });
    },
    reverse: (ref: string) => {
      const t = transfers.get(ref)!;
      t.status = 'reversed';
      statements.push({
        id: String(++sequence),
        domain: 'test',
        currency: 'NGN',
        difference: t.amount,
        model_responsible: 'Transfer',
        model_row: t.id,
        createdAt: new Date().toISOString(),
      });
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

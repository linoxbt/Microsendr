# MicrosendrPay

`MicrosendrPay.sol` is the on-chain escrow behind Microsendr purchases (airtime, mobile data,
subscription and gift cards) paid in QUSDC on QIE Mainnet (chain 1990).

## How a purchase moves

1. The customer approves the purchase in the app (payment PIN or passkey). Their Microsendr
   wallet sends the exact price in QUSDC to the MicrosendrPay contract: one ordinary token transfer.
2. Once that transfer is confirmed, the Microsendr operator calls `hold(orderId, payer, amount)`.
   The contract only accepts it if that many unallocated tokens actually arrived, and only once
   per order.
3. The order is placed with the provider.
   - Delivered: the operator calls `settle(orderId)` and the payment goes to the treasury.
   - Not delivered: the operator calls `refund(orderId)` and the payment goes back to the payer.
4. If an order is never resolved, the payer can call `refund(orderId)` themselves seven days
   after it was held. Money held for an order can only ever reach the treasury on delivery or
   return to the wallet that paid; the owner can sweep only tokens that are not held.

`orderId` is `keccak256` of the Microsendr order id (for example `bil_…`), so every on-chain
event matches an order in the app. Each order's receipt in the app links its `hold` and
`settle`/`refund` transactions on the QIE explorer.

## Build and test

```sh
node --import tsx scripts/compile-contracts.ts   # writes contracts/artifacts/*.json
npx tsx --test tests/microsendr-pay.test.ts       # contract tests on an in-process chain
npx tsx --test tests/bills.test.ts                # end to end: app order -> hold -> settle/refund
```

Compiled with solc 0.8.38, optimizer on (200 runs), EVM version `paris`.
`contracts/test/TestToken.sol` is a 6-decimal token used only by the tests.

## Deploy to QIE Mainnet

```sh
DEPLOYER_PRIVATE_KEY=0x… BILLS_TREASURY_ADDRESS=0x… OPERATOR_ADDRESS=0x… \
  node --import tsx scripts/deploy-microsendr-pay.ts            # dry run
DEPLOYER_PRIVATE_KEY=0x… BILLS_TREASURY_ADDRESS=0x… OPERATOR_ADDRESS=0x… \
  node --import tsx scripts/deploy-microsendr-pay.ts --deploy   # deploy
```

The deployer becomes the owner and pays gas in QIE. The address is written to
`contracts/deployments/qie-mainnet.json`. Then, on the Railway `api` and `worker` services, set
`MICROSENDR_PAY_ADDRESS` and `OPERATOR_PRIVATE_KEY` (the operator account's key; keep a little
QIE in it for gas). From then on customers pay the contract and the worker holds, settles and
refunds automatically.

## Verify the source

On the QIE explorer (https://mainnet.qie.digital), open the contract address, choose
**Verify & publish**, method **Solidity (Standard JSON input)**, compiler `v0.8.38`, and upload
the `standardJsonInput` object from `contracts/artifacts/MicrosendrPay.json` (save it as its
own JSON file first). Constructor arguments are the QUSDC address, the treasury and the operator.

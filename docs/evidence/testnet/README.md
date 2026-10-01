# Testnet evidence

Reports written by `yarn verify:testnet` ([docs/testnet-validation.md](../../testnet-validation.md)), one pair per run:
`<runId>.md` (for people) and `<runId>.json` (complete audit reports). They come from real Hedera Testnet runs only:
never write or edit them by hand.

## Runs

No live run recorded yet. To produce the evidence, with an ECDSA Testnet operator in the root `.env`:

```bash
yarn setup
yarn hcs:topic --write                  # if HEDERA_HCS_TOPIC_ID is empty
yarn deploy --network hederaTestnet     # if no CredentialRegistry is configured
yarn verify:testnet --yes
```

Then commit the generated `docs/evidence/testnet/<runId>.md` and `.json` (and `packages/sdk/generated` if a deploy
happened), and list the run here.

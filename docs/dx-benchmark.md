# Benchmark de DX em scaffolds multi-chain → decisões para o Scaffold-HBAR

> Referência arquitetural e de produto para decisões de experiência de desenvolvedor (DX) deste template. Responde à issue **#2** e produz requisitos concretos para as issues **#4**, **#24**, **#11** e **#12**.
> Não é um catálogo: cada padrão observado passa por um filtro explícito de compatibilidade com **Hedera**, **EVM** e o caso de uso da issue **#21**.

| Metadado | Valor |
|---|---|
| Data da análise | **2026-09-18** |
| Método | Leitura de código-fonte, templates e documentação **oficial** de cada projeto (SHAs no [Anexo](#anexo-fontes)). **Nenhum CLI foi executado** — ver [limitações](#limitações) |
| Caso de uso vigente | Programmable/Verifiable Settlement (oracle → HCS → `SettlementRouter` → HTS → Mirror Node). **#21 ainda está aberta** — a sensibilidade das decisões a essa issue está na [seção 9](#sensibilidade-21) |
| Documentos relacionados | [bounty-rules.md](bounty-rules.md) (gate e rubrica), [architecture.md](architecture.md), [integration.md](integration.md) |

**Convenção de evidência** usada em todo o documento:

- **[E]** — observado diretamente em código/documentação (com caminho do arquivo ou link).
- **[I]** — inferência ou julgamento do autor a partir de evidências [E].
- **[NV]** — não verificado; precisa de teste antes de virar dependência.

Chaves de projeto: **SE2** Scaffold-ETH 2 · **CE** create-eth · **HBAR** scaffold-hbar (oficial Hedera) · **CSH** create-scaffold-hbar (CLI) · **HUI** scaffold-hbar-ui · **OK** OnchainKit/create-onchain (Base) · **CSD** create-solana-dapp · **SOLT** solana-foundation/templates · **APT** create-aptos-dapp · **SUI** @mysten/create-dapp · **NEAR** create-near-app · **STL** Scaffold Stellar CLI · **STLUI** Scaffold Stellar UI · **STK** Scaffold-Stark · **RELAY** hiero-json-rpc-relay.

---

## 1. Sumário executivo

**Tese central.** Os scaffolds maduros não vencem por ter mais funcionalidades, e sim por **fechar o ciclo contrato → tipos → UI → prova on-chain sem passos manuais e sem erros genéricos**. Em todos os melhores casos (SE2, Solana/Codama, Stellar) o desenvolvedor nunca copia endereço ou ABI, e todo erro chega ao usuário com causa, e às vezes com o comando que resolve.

**O que já existe no Scaffold-HBAR base e não deve ser refeito** [E]: codegen de ABI/endereços (`generateTsAbis`), hooks tipados por nome, página `/debug`, keystore criptografado para o deployer, verificação via Sourcify com link HashScan, resolução EVM→Account ID via Mirror Node, banner de erro de cadeia local ([seção 2.2](#baseline)).

**Onde o Scaffold-HBAR base (e portanto este template) está aquém do estado da arte** [E]/[I]:

1. **Erros genéricos.** `getParsedError` é cópia literal do SE-2: ignora os códigos estruturados do relay Hedera (`-32606` rate limit HBAR, `-32003` transação rejeitada com `hederaStatus`, `-32020` falha do Mirror Node…) — [RELAY].
2. **Sem validação de ambiente ("doctor")** antes de operar, ao contrário de Stellar (`dev-guard`), Solana (`versions`) e NEAR (checagem de `cargo-near`).
3. **Codegen só de contratos.** O fluxo deste projeto depende também de **tópico HCS** e **token HTS**, que não são contratos e não passam por EVM — não há sistema contract para HCS [E].
4. **Segredos/keys padrão no template** (WalletConnect projectId e chave Hardhat #0 como fallback).
5. **Configuração de rede triplicada** (hardhat, next, rota de API) com nomes de variáveis divergentes dos `.env.example` do projeto.

**Cinco decisões de maior alavancagem** (detalhadas nos requisitos):

| # | Decisão | Onde entra |
|---|---|---|
| 1 | **Manifesto de deployments** (contratos **+ topic HCS + token HTS**, com Account/Contract ID *e* endereço EVM, URL HashScan, status de verificação) como saída única do codegen | #24 → consumido por #11 e #12 |
| 2 | **Taxonomia de erros tipada** (`classifyError`) tabelada sobre os códigos reais do relay, do SDK Hedera e do ABI, com fixture por código | #12 (+ #24 gera erros do ABI) |
| 3 | **Máquina de estados do fluxo** (oracle → HCS → Mirror → contrato → HTS → auditoria) com **dois identificadores** (Transaction ID e hash EVM) e estado explícito "aguardando indexação do Mirror Node" | #12 |
| 4 | **`doctor` / `setup` fail-fast** com remediação acionável, compartilhado por CLI, CI e dashboard (`/api/env/status`) | #4 → #11 |
| 5 | **Caminho padrão = Testnet + oracle mock determinístico**; Local Node e forking são opcionais (não emulam o fluxo inteiro) | #4 |

**Respostas rápidas às perguntas-guia** (versão completa na [seção 11](#respostas-guia)):

- *O que o dev recebe ao criar o projeto?* Ver [REQ-04-01…04](#req-04) e [10.1](#respostas-guia).
- *Como contratos e tipos chegam ao frontend?* Pelo manifesto versionado de [REQ-24-01…03](#req-24).
- *Como apresentar erros de wallet/RPC/rede?* Taxonomia de [REQ-12-03](#req-12), painel persistente, não só toast.
- *Como integrar HashScan/Mirror Node ao fluxo?* Um único construtor de links + Mirror como sinal de "fim" ([REQ-11-03](#req-11), [REQ-12-02](#req-12), [REQ-12-05](#req-12)).

---

## 2. Contexto: o que torna Hedera diferente e o que já existe

<a id="particularidades"></a>

### 2.1 Particularidades Hedera/EVM que decidem o que se aplica

Cada linha é um filtro usado na [seção 6](#padroes) e na [seção 8](#nao-aplicavel).

| # | Fato | Evidência | Consequência de DX |
|---|---|---|---|
| H1 | **Não existe system contract para publicar em HCS** a partir de Solidity. System contracts existentes: HTS `0x167`, Exchange Rate `0x168`, PRNG `0x169`, Account Service `0x16a`, Schedule Service `0x16b`. | [E] docs.hedera.com — *System smart contracts* | O fluxo do projeto **não é atômico** entre HCS e contrato. Publicação HCS exige **SDK/transação nativa** (server-side com operator key ou wallet nativa). Hooks wagmi cobrem só a parte EVM. |
| H2 | **Dois sistemas de identificadores**: hash EVM (`0x…`) e Transaction ID (`0.0.x@segundos.nanos`). O relay devolve ambos em rejeições (`data.txHash`, `data.transactionId`). Mensagens HCS **não têm hash EVM**. | [E] RELAY `JsonRpcError.ts` (`TRANSACTION_REJECTED_DETAILED`) | UI e evidências (#18, #20) devem mostrar e linkar o identificador correto por etapa. |
| H3 | **Relay JSON-RPC com erros estruturados**: `-32010` timeout, `-32606` rate limit HBAR, `-32020` falha upstream do Mirror Node, `-32003` tx rejeitada (`hederaStatus`, `provisional`), `-32009` gas price baixo, `-32000` fundos insuficientes, `3` revert. | [E] RELAY `JsonRpcError.ts` | Classificação de erros precisa ser específica a Hedera, não a viem genérico. |
| H4 | **Hashio é só para dev/teste**; produção pede relay comercial/próprio. Chain IDs: 295 (mainnet), 296 (testnet), 297 (previewnet), 298 (local). | [E] docs.hedera.com — *JSON-RPC relay*; [E] LNODE | Dashboard deve detectar rate limit e apontar para RPC alternativo por env. |
| H5 | **Decimais**: `msg.value`/`gasPrice` usam 18 casas no JSON-RPC, enquanto HBAR nativo/HTS usam 8 (tinybar). | [E] docs.hedera.com; [E] HBAR `scaffold.config.ts` (comentário) | Conversão de unidades é fonte real de bug; helper único testado (HUI `IntegerInput` ×1e8/×1e18 já existe). |
| H6 | **Mirror Node é a fonte de leitura verificável, com consistência eventual.** | [E] projeto: `AGENTS.md`, issue #10 | Nenhum scaffold de outros ecossistemas modela esse estado; precisa ser primeiro-classe na UI. |
| H7 | **Funding em testnet exige registro no Portal** (conta recebe 1000 HBAR ao ser criada); em reset de testnet **os Account IDs mudam** (chaves permanecem). Não há API de airdrop/Friendbot no fluxo. | [E] docs.hedera.com — *Testnet access* | O "botão de airdrop" de Solana/Stellar **não se transfere**; precisa de guia + detecção de "conta não encontrada". |
| H8 | **Dev local tem duas opções com custos distintos.** *Forking* (`@hashgraph/system-contracts-forking`) emula **só o HTS** a partir do Mirror Node e "does not replicate Hedera Token Services fully". *Local Node* (Docker) traz consenso+mirror+relay+HashScan local, exige **16 GB RAM, 6 CPUs/8 GB no Docker**, usa a porta **3000 (Grafana)** e **zera o estado ao parar**. | [E] FORK; [E] LNODE | Nenhuma opção cobre o fluxo completo de forma leve (forking não emula HCS). Default deve ser Testnet. Conflito de porta com Next.js (3000) a documentar. |
| H9 | **Duas famílias de wallet**: EVM (`eip155:296` via relay) e nativa (`hedera:testnet`, `hedera_signAndExecuteTransaction`). Wallets listadas: HashPack, Kabila, Dropp. | [E] HWC | Escolher um caminho por versão; misturar dobra a superfície de erro e de teste. |
| H10 | **Verificação de contratos via Sourcify** (sem Etherscan API); HashScan usa `/account/…` para endereços EVM (não `/address/`). | [E] HBAR `hardhat.config.ts`, `networks.ts` | Construtor de links próprio; já parcialmente resolvido no base. |

### 2.2 Baseline: o que o Scaffold-HBAR já entrega hoje <a id="baseline"></a>

Estado de `hedera-dev/scaffold-hbar@5eb46ef` [E]. O que consta abaixo **não deve ser reimplementado** por #24/#11/#12; deve ser reutilizado ou estendido.

| Capacidade | Onde | Observação |
|---|---|---|
| Codegen ABI/endereços após deploy | `packages/hardhat/scripts/generateTsAbis.ts`, encadeado à task `deploy` em `hardhat.config.ts` | Apenas contratos; sem Contract ID/Account ID nem token/topic |
| Hooks tipados por nome | `hooks/scaffold-hbar/useScaffold{Read,Write}Contract`, `useTransactor`, `useScaffoldEventHistory` | Cópias do SE-2 com prefixo renomeado |
| Página `/debug` | `app/debug`, `HUI/packages/debug-contracts` | HUI adiciona `IntegerInput` com ×1e8/×1e18 |
| Resolução EVM → Account ID | `app/api/hedera/account/route.ts`, `useHederaAccountId` | Já usa Mirror Node via rota server-side |
| Erro de cadeia local fora do ar | `LocalChainErrorBanner` + `useLocalChainConnectionError` | **Bom padrão**: mensagem + comando exato + fallback automático para Testnet |
| Keystore criptografado do deployer | `scripts/generateAccount.ts`, `runHardhatDeployWithPK.ts` | Pede senha interativa (bloqueia CI) |
| Verificação + link HashScan | task `verify` estendida | Sourcify |
| Local com HTS emulado | `HEDERA_FORKING=true` + `@hashgraph/system-contracts-forking` | Só HTS (H8) |
| Guia para agentes de IA | `AGENTS.md`, `.agents/`, `.claude/` | HUI ainda inclui um servidor MCP |

**Lacunas do baseline relevantes a este projeto** [E]/[I]:

- `getParsedError` = SE-2 idêntico (H3 não tratado).
- `useScaffoldWriteContract` avisa "não implantado" mas sem rede/comando específico da rede atual.
- Chave WalletConnect default e chave Hardhat #0 como fallback em `hardhat.config.ts` (usadas mesmo em `hederaTestnet`).
- `enableBurnerWallet: true` para todas as redes-alvo, que incluem **mainnet**.
- URL do RPC de testnet **hardcoded** em `hardhat.config.ts`; outra em `scaffold.config.ts` (`NEXT_PUBLIC_…`); URLs do Mirror em `app/api/hedera/account/route.ts` (`HEDERA_MIRROR_TESTNET_URL`). O `.env.example` deste projeto usa outros nomes (`HEDERA_MIRROR_NODE_URL`, `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, **e** `HEDERA_OPERATOR_KEY`).
- Convenção de script herdada: **`start` = `next dev`** e **`serve` = `next start`** (o inverso da semântica usual do npm). Relevante para o gate "start funcionando" ([bounty-rules D-11](bounty-rules.md#divergencias)).

---

## 3. Método, escopo e limitações

<a id="limitações"></a>

**Escopo obrigatório coberto:** Scaffold-ETH 2 / Base, create-solana-dapp, create-aptos-dapp, Sui create-dapp, create-near-app, Stellar. **Adicionais:** Scaffold-Stark (mostra como adaptar o padrão SE-2 a uma cadeia não-EVM), Scaffold-HBAR base (linha de base) e scaffold-hbar-ui.

**Sobre Base:** `coinbase/build-onchain-apps` está **arquivado** (último push 2025-02-05) [E]. O scaffold vigente é `create-onchain` + OnchainKit, que é **somente frontend** (Next.js/MiniKit; sem contratos nem codegen) [E]. O lado de contratos para Base é atendido por SE-2 (que inclui a rede Base). Por isso "SE2/Base" aparece combinado.

**Sobre Stellar:** o projeto vive em `stellar-scaffold/cli` e `stellar-scaffold/ui` (o repositório antigo `theahaco/scaffold-stellar` não foi usado) [E].

**Critérios da análise (11 dimensões pedidas):** fluxo de setup · automação do ambiente inicial · ABI/tipos/bindings · hooks/wrappers · debug · console/dashboard · erros de rede · erros de wallet · explorer · experiência de testnet · redução de boilerplate.

**Escala de maturidade** usada na matriz da [seção 5](#matriz) **[I]**: `0` ausente/não identificado · `1` manual ou só documentação · `2` parcial/opt-in · `3` automatizado **e** integrado ao fluxo. `n/v` = não verificado.

### Limitações

1. **Análise estática.** Leitura de repositórios em 2026-09-18; **não executei** `create-eth`, `create-solana-dapp` etc. Comportamentos de runtime (mensagens exibidas de fato, tempo de setup) são [I] a partir do código.
2. **Ratings são julgamento [I]**, com a evidência [E] ao lado; não são métricas.
3. **Sem validação com desenvolvedores reais.** Nenhum teste de usabilidade; "atrito" é inferido.
4. **Cobertura de arquivos:** li os arquivos centrais de cada fluxo, não o repositório inteiro. Onde uma capacidade "não foi identificada", isso significa não encontrada nos arquivos lidos.
5. Documentação Hedera consultada via extração de páginas; valores numéricos citados (16 GB, portas) vêm dela e devem ser reconferidos antes de virarem requisito de pré-condição.

---

## 4. Análise por scaffold <a id="analise"></a>

Cada subseção: tabela nas 11 dimensões (com evidência) + "como a experiência é apresentada e integrada" + lições.

### 4.1 Scaffold-ETH 2 (e Base via SE2) — `scaffold-eth/scaffold-eth-2@6cdf354`, `create-eth@aee6c6d`

**Posicionamento:** referência de mercado para dApps EVM full-stack; o próprio Scaffold-HBAR descende dele.

| Dimensão | Observação |
|---|---|
| Setup/criação | `npx create-eth@latest`; suporta **extensions** (CE `src/extensions/`, `contributors/THIRD-PARTY-EXTENSION.md`). Requisito Node ≥ 22.10 [E README]. Depois **três terminais**: `yarn chain`, `yarn deploy`, `yarn start` [E README]. |
| Automação inicial | Gera conta do deployer com keystore criptografado (`account:generate/import/reveal-pk`, `runHardhatDeployWithPK.ts` pede senha) [E]. Não há etapa única "setup" nem validação de ambiente. |
| ABI/tipos | `generateTsAbis.ts` roda "as the last deploy script" e escreve `packages/nextjs/contracts/deployedContracts.ts` (por chainId), incluindo **funções herdadas** [E]. Arquivo tem aviso "autogenerated… do not edit". `externalContracts.ts` para contratos de terceiros [E]. |
| Hooks/abstrações | `useScaffoldReadContract`, `useScaffoldWriteContract`, `useScaffoldEventHistory`, `useScaffoldWatchContractEvent`, `useDeployedContractInfo`, `useTransactor` — **por nome de contrato**, tipados a partir do ABI gerado [E]. |
| Debug | Página **Debug Contracts** (`app/debug`) com UI de leitura/escrita por contrato, via `@scaffold-ui/debug-contracts` [E]. |
| Console/dashboard | Debug + **block explorer local** (`app/blockexplorer/*`, 16 arquivos) [E]. Sem painel de saúde de ambiente. |
| Erros de rede | Parsing de erro viem (`getParsedError`); revert com **decodificação de custom error em todos os ABIs** (`getParsedErrorWithAllAbis`: monta tabela seletor→nome) [E]. `useTransactor` distingue "aguardando confirmação do usuário" → "aguardando conclusão" → sucesso/erro [E]. |
| Erros de wallet | Guarda explícita em `useScaffoldWriteContract`: "Please connect your wallet", "Wallet is connected to the wrong network. Please switch to X"; `WrongNetworkDropdown` com ação de trocar [E]. Simulação prévia (`simulateContractWriteAndNotifyError`, desativável) antes do prompt da wallet [E]. |
| Explorer | `getBlockExplorerTxLink(chainId, hash)` a partir da config viem; toda notificação de tx traz link "check out transaction" [E]. |
| Testnet | Redes via `scaffold.config.ts` (`targetNetworks`); faucet e burner wallet **só locais** por padrão (`burnerWalletMode: "localNetworksOnly"`) [E]. Deploy remoto via keystore. |
| Boilerplate | Alta: `scaffold.config.ts` único; AGENTS.md/CLAUDE.md/`.cursor`/`.agents` para agentes de IA [E]. |

**Como é apresentado:** a promessa "Contract Hot Reload" [E README] é entregue porque tudo passa por **um único arquivo gerado** que os hooks leem. O desenvolvedor aprende o padrão usando: o próprio hook lança mensagem que diz o que fazer ("did you forget to run `yarn deploy`?") [E].

**Lições:** (a) *ABI gerado como contrato único entre back e front*; (b) *mensagens de erro que carregam o comando de remediação*; (c) *simulação antes da wallet*; (d) *burner/faucet restritos a rede local*; (e) **defaults perigosos**: chaves Alchemy e WalletConnect compartilhadas **commitadas** em `scaffold.config.ts` [E] — anti-padrão A-01.

### 4.2 Base — `coinbase/onchainkit@25415d7` (`create-onchain`)

| Dimensão | Observação |
|---|---|
| Setup | `npx create-onchain` (+ `--mini` para Farcaster Mini-Apps, `--manifest`) [E]. |
| Automação inicial | `.template.env` com `NEXT_PUBLIC_ONCHAINKIT_API_KEY=""` — **depende de chave do fornecedor** [E]. Telemetria do CLI é perguntada via **prompt** (`analyticsPrompt`, `analytics.ts`) [E]; texto exato do prompt não lido. |
| ABI/tipos | **Não identificado** (templates sem contratos/codegen) [E]. |
| Hooks/abstrações | Componentes compostos `<Transaction>`, `TransactionButton`, `TransactionStatus`, `TransactionToast`, `TransactionSponsor` (paymaster) [E]. |
| Debug / console | Não identificado. |
| Erros de rede | Mensagem de erro exibida no próprio status (`errorMessage` → rótulo em vermelho) [E]. |
| Erros de wallet | `isUserRejectedRequestError` (checa `cause.name` e `shortMessage`) e estado "Confirm in wallet." [E]. |
| Explorer | Toast com "View transaction" → `${chainExplorer}/tx/${hash}` [E]. |
| Testnet | Não específico. |
| Boilerplate | Médio: componentes prontos, mas sem camada de contrato. |

**Lição principal:** **ciclo de vida explícito da transação** — `buildingTransaction` → `transactionPending` ("Confirm in wallet.") → "Transaction in progress..." → "Successful"/erro [E `useGetTransactionStatusLabel.tsx`]. A UI é uma projeção de uma máquina de estados, não de callbacks soltos. **Anti-padrão:** exigir chave de terceiro para o primeiro run.

### 4.3 create-solana-dapp — `solana-foundation/create-solana-dapp@e9c1bba`, `templates@9e4bbfc`

| Dimensão | Observação |
|---|---|
| Setup | `npm create solana-dapp@latest`; `-t <org/repo>` via giget (templates externos) [E]. Init script no `package.json` do template: `instructions` (saída pós-instalação; `+` = negrito; `{pm}`), `versions` (avisa se `anchor`/`solana` ausentes ou antigos), `rename`, `skills`, e **flags de opção por grupo** (`--ollama`, `--reset-project`) [E README]. |
| Automação inicial | `npm run setup` = `anchor build` + `codama:js` (constrói programa e gera cliente) [E `kit/nextjs-anchor/package.json`]. Sem validação de saldo/conta. |
| ABI/tipos | **Codama** gera cliente TypeScript a partir do IDL: instruções, PDAs, programa e **enum de erros com mensagens** (`getVaultErrorMessage`); saída **commitada** em `app/generated/vault/` [E]. |
| Hooks/abstrações | `useSendTransaction` (estado `isSending`, revalida saldo após enviar), `useBalance` (SWR), `useWallet`; builders de instrução gerados [E]. Não há hooks por nome de programa. |
| Debug | Não identificado (usa Explorer). |
| Console/dashboard | Cabeçalho com **seletor de cluster** e saldo; sem painel de saúde [E]. |
| Erros de rede | `parseTransactionError`: percorre a cadeia `cause` até a mensagem mais profunda, trunca a 200 chars [E]. |
| Erros de wallet | Trata "User rejected" separadamente; wallet-standard com auto-descoberta [E]. |
| Explorer | `getExplorerUrl(path, cluster)` — **um módulo** que trata mainnet/devnet/testnet e `localnet` (`cluster=custom&customUrl=`) [E]. Toasts com link para cada tx [E README]. |
| Testnet | Seletor devnet/testnet/mainnet/localnet; **botão de airdrop** em redes de teste [E README]. |
| Boilerplate | Alta; `skills` de IA instaladas por padrão (pode ser `[]`) [E]. |

**Lições:** (a) **erros do programa viram dados tipados** no codegen — a UI não mantém tabela manual; (b) **`versions`** como checagem de pré-requisito no scaffold; (c) `instructions` como *next steps* impressos ao final; (d) construtor de explorer único e parametrizado por rede; (e) saída gerada **commitada** → `lint`/`build` funcionam de um clone limpo.

### 4.4 create-aptos-dapp — `aptos-labs/create-aptos-dapp@97c2e8a`

| Dimensão | Observação |
|---|---|
| Setup | `npx create-aptos-dapp@latest` com prompts; templates: Boilerplate, Digital Asset, Fungible Asset (+ exemplos educacionais). Requer Python 3.6+ [E README]. |
| Automação inicial | Gera `.env`; em **devnet** cria e **financia** automaticamente a conta publicadora; em **testnet** imprime instrução para financiar manualmente e preencher `.env` [E `createModulePublisherAccount.ts`]. Existe `installAptosCli.ts` [E; conteúdo não lido]. |
| ABI/tipos | Script `get_abi.js` **busca o ABI do full node após publicar, com `sleep` fixo de 5 s** e grava `frontend/utils/*_abi.ts`; cliente tipado via **Surf** (`client.useABI(ABI).post_message(...)`) [E]. |
| Hooks/abstrações | `useWalletClient` do Surf; pasta `entry-functions/` e `view-functions/` [E]. |
| Debug / console | Não identificado; componentes `WalletDetails`, `NetworkInfo`, `AccountInfo` exibem estado [E nomes]. |
| Erros de rede | `toast` destrutivo com `error`; sem taxonomia [E]. |
| Erros de wallet | **`WrongNetworkAlert`**: modal bloqueante quando a rede da wallet ≠ `NETWORK` [E]. |
| Explorer | Não verificado nos arquivos lidos. |
| Testnet | Financiamento manual pela web do faucet [E]. |
| Boilerplate | Alta: comandos Move encapsulados em `npm run move:{compile,publish,upgrade,test}` via pacote `aptos-cli` (sem instalar CLI global) [E]. |

**Lições positivas:** (a) **`publish` reescreve o endereço implantado de volta no `.env`** (`VITE_MODULE_ADDRESS`) — propagação deploy→app automática [E]; (b) CLI encapsulada em scripts npm.
**Anti-padrões observados:** (a) chave privada gravada em `.env` com prefixo `VITE_` (convenção do Vite para variáveis expostas ao cliente) [E `setUpEnvVariables.ts`]; (b) `sleep(5000)` em vez de polling; `publish.js` usa `.then` sem `.catch`; (c) telemetria (`recordTelemetry`, GA4) chamada em `generateDapp.ts`; **não encontrei fluxo de consentimento** nos arquivos lidos [E/NV].

### 4.5 Sui create-dapp — `MystenLabs/ts-sdks@59dedfe` (`packages/create-dapp`)

| Dimensão | Observação |
|---|---|
| Setup | `pnpm create @mysten/dapp`; templates `react-client-dapp` e `react-e2e-counter` [E]. Instalação do Sui CLI, `new-env`, `new-address` e faucet são **manuais** (README) [E]. |
| Automação inicial | Baixa: passos de CLI documentados, não automatizados [E]. |
| ABI/tipos | `@mysten/codegen` (`sui-ts-codegen generate`, config `sui-codegen.config.ts`) gera bindings TS de Move para `src/contracts/`; `pnpm codegen` **manual** [E]. |
| Hooks/abstrações | `@mysten/dapp-kit-react` (`useDAppKit`, `useCurrentClient`); builders gerados (`tx.add(createCounter())`) [E]. |
| Debug / console | Não identificado; componentes de exemplo `WalletStatus`, `OwnedObjects`. |
| Erros de rede | Exemplo faz `throw new Error("Transaction failed")` — **mensagem genérica** [E `CreateCounter.tsx`]. |
| Erros de wallet | Burner wallet **só em DEV** (`enableBurnerWallet: import.meta.env.DEV`) [E]. |
| Explorer | Não identificado no template lido. |
| Testnet | `defaultNetwork: "testnet"`, gRPC por rede; **IDs de pacote são constantes `undefined` com `// TODO: Update these…` após `sui client publish`** [E `constants.ts`]. |
| Boilerplate | Média. |

**Lições:** (a) `waitForTransaction` + leitura de `effects` para descobrir o objeto criado (aguarda indexação antes de ler); (b) **anti-padrão A-03**: publicação exige editar constantes na mão, exatamente o que #24 quer eliminar.

### 4.6 create-near-app — `near/create-near-app@ff0fedd` (último commit em 2026-01-08)

| Dimensão | Observação |
|---|---|
| Setup | `npx create-near-app@latest` com flags (`--frontend next-app\|next-page\|none --contract js\|rs\|none --install`) [E]. Mensagem final com "Next steps" por combinação [E `messages.ts`]. Detecta `cargo-near` ausente [E `checkCargoNear.ts`]. |
| Automação inicial | `--install` instala dependências de todos os `package.json`; testes em **sandbox** local [E]. |
| ABI/tipos | **Não identificado**: chamadas por string (`viewFunction({ method: 'get_greeting' })`) [E]. |
| Hooks/abstrações | `useNearWallet()` → `signedAccountId`, `viewFunction`, `callFunction` (`near-connect-hooks`) [E]. |
| Debug / console | Não identificado. |
| Erros de rede/wallet | Exemplo faz **atualização otimista sem tratamento de falha**; comentário diz "revert if it fails", mas não há `catch` [E `hello-near/page.tsx`]. |
| Explorer | Não identificado. |
| Testnet | `NetworkId = 'testnet'` e **contrato de exemplo já implantado** (`hello.near-examples.testnet`) usado pelo frontend — **funciona no primeiro run sem deploy** [E `config.ts`]; deploy via `near create --useFaucet` [E]. |
| Boilerplate | Média. Telemetria PostHog **divulgada na mensagem de boas-vindas** e desativada em CI [E `tracking.ts`]. |

**Lições:** (a) **frontend funcional antes de qualquer deploy** apontando para um recurso de referência; (b) **anti-padrão A-05** (otimismo sem rollback) e ausência de tipos.

### 4.7 Stellar — `stellar-scaffold/cli@e58f9d8`, `ui@88bd964`

| Dimensão | Observação |
|---|---|
| Setup | `cargo install --locked stellar-scaffold-cli` → `stellar scaffold init my-project`; pré-requisitos: Rust, Node, Stellar CLI e **Docker** (nó local) [E]. Fricção de instalação alta. `stellar scaffold upgrade` adapta workspace existente [E]. |
| Automação inicial | **A mais alta observada.** `environments.toml` por ambiente (`development`/`staging`/`production`): rede, contas (criadas e financiadas em dev), contratos com `constructor_args` e `after_deploy`; `run-locally = true` sobe o container [E]. `stellar scaffold watch --build-clients` recompila, reimplanta e regenera clientes ao salvar (`npm run dev` roda watch + Vite) [E]. |
| ABI/tipos | Cliente NPM tipado **por contrato** gerado em `packages/*` e reexportado em `src/contracts/`; `client = true` só em dev/testing [E]. |
| Hooks/abstrações | `useWallet`, `useNotification`, `useSubscription`, providers [E nomes]. |
| Debug | A página **Debug/Contract Explorer foi removida** do template: "being converted to a standalone Extension… In the meantime, use the Stellar Lab" [E `Debug.tsx`]. |
| Console/dashboard | `NetworkPill`, `ConnectAccount`; sem painel de saúde [E nomes]. |
| Erros de rede/wallet | Não identificados de forma específica nos arquivos lidos (`NotificationProvider`) [NV]. |
| Explorer | Delegado ao **Stellar Lab** (link) [E]. |
| Testnet | `.env.example` alterna LOCAL/TESTNET/MAINNET por comentários; **`FundAccountButton`** (Friendbot) no UI [E]. |
| Boilerplate | Muito alta. **`prestart` guard** (`dev-guard.mjs`) verifica `stellar` e `stellar scaffold` e imprime comando de instalação + link [E]. `CLAUDE.md` no template [E]. |

**Lições:** (a) **um arquivo de configuração por ambiente** orquestra deploy + codegen; (b) **guard no `prestart`** com remediação; (c) **manutenção de um debug UI genérico é cara** — o projeto o retirou e apontou para o explorer/lab (evidência para A-09); (d) `client=true` restrito a ambientes descartáveis (não regenerar contra produção).

### 4.8 Scaffold-Stark (secundário) — `Scaffold-Stark/scaffold-stark-2@ae1b689`

Fork do SE-2 para Starknet [E]. Relevante como **estudo de adaptação a cadeia não-EVM**: mantém o mesmo esqueleto (debug page, hooks `useScaffold*`, `deployedContracts`, burner wallet + contas pré-financiadas, `yarn chain/deploy/start`) e adiciona `useScaffoldMultiWriteContract` (multicall), `useScaffoldWebSocketEvents`, **Dev Containers** e instalador de toolchain (`starkup`) [E]. Diferencial de qualidade: **a maioria dos hooks tem teste unitário** (`hooks/scaffold-stark/__tests__/*`, 19 arquivos) [E], ao contrário do SE-2 que não os inclui [E árvore]. Lição: portar o padrão SE-2 é viável, mas os hooks precisam de testes porque a semântica muda (aqui: multicall — **não se aplica** a Hedera, ver N-03).

### 4.9 Scaffold-HBAR (baseline) e scaffold-hbar-ui

Ver [seção 2.2](#baseline). Adicional: HUI expõe `Address`, `Balance`, `HederaAddress`, `HederaAddressInput`, `HbarInput`, hooks `useHederaAccountId`/`useMirrorNodeAccount`, `debug-contracts` com `IntegerInput` (×1e8/×1e18) e um **servidor MCP** para agentes [E]. É o único conjunto de componentes que já conhece H2 e H5.

---

## 5. Matriz comparativa <a id="matriz"></a>

Escala **[I]**: `0` ausente · `1` manual/doc · `2` parcial/opt-in · `3` automatizado e integrado · `n/v` não verificado. Julgamento do autor a partir das evidências da [seção 4](#analise).

| Dimensão | SE2 | Base (OK) | Solana | Aptos | Sui | NEAR | Stellar | Stark | HBAR hoje |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 Setup/criação | 3 | 3 | 3 | 3 | 3 | 3 | 2 | 2 | 3 |
| 2 Automação do ambiente | 2 | 2 | 2 | 2 | 1 | 2 | **3** | 2 | 2 |
| 3 ABI/tipos/bindings | 3 | 0 | **3** | 2 | 2 | 0 | **3** | 3 | 3 |
| 4 Hooks/wrappers | **3** | 2 | 2 | 2 | 2 | 2 | 2 | **3** | **3** |
| 5 Debug | **3** | 0 | 1 | 0 | 0 | 0 | 1 | **3** | **3** |
| 6 Console/dashboard | 3 | 0 | 1 | 1 | 1 | 0 | 1 | 3 | 2 |
| 7 Erros de rede | 2 | 1 | 2 | 1 | 1 | 1 | n/v | n/v | 1 |
| 8 Erros de wallet | 2 | 2 | 2 | 2 | 2 | 1 | n/v | n/v | 2 |
| 9 Explorer | 2 | **3** | **3** | n/v | 1 | 1 | 1 | n/v | 2 |
| 10 Testnet | 2 | 1 | **3** | 1 | 1 | 2 | **3** | n/v | 2 |
| 11 Redução de boilerplate | 3 | 2 | 3 | 2 | 2 | 2 | **3** | 3 | 3 |

**Leitura:** nenhum scaffold pontua `3` em erros de rede (dimensão 7). É o espaço onde o Scaffold-HBAR pode **liderar**, porque o relay Hedera fornece códigos estruturados (H3) e o projeto precisa distinguir seis cenários de falha (issue #12). Testnet e ambiente (dimensões 2 e 10) são os pontos onde Stellar e Solana definem o padrão a ser adaptado — com o limite de H7.

---

## 6. Padrões recomendados <a id="padroes"></a>

Formato: **referência** · **por que reduz atrito** · **compatibilidade Hedera/EVM/#21** · **veredito** (`Adotar` como está · `Adaptar` · `Adiar`).

| ID | Padrão | Referência | Por que funciona | Compatibilidade | Veredito |
|---|---|---|---|---|---|
| **P-01** | **Caminho feliz de 2 comandos com falha rápida** (`setup` → `dev`), setup valida antes de agir | SOLT `setup`; STL `watch`; APT (`.env` gerado) | Erro de configuração aparece no minuto 1, não como falha opaca de transação (#5) | Hedera: financiar a conta **não é automatizável** (H7) → `setup` deve **esperar** o saldo (poll) após mostrar o link do faucet, em vez de falhar como APT | **Adaptar** |
| **P-02** | **Mensagem final de "próximos passos"** gerada por template | SOLT `instructions`; NEAR `messages.ts`; HBAR templates (`outro` em `template.json`) | Ensina o fluxo no momento em que o dev está olhando o terminal | 100% compatível: campo `outro` já existe no schema do CSH [E `types.ts`] | **Adotar** |
| **P-03** | **Guard de pré-requisitos com instrução de instalação** | STL `dev-guard.mjs`; SOLT `versions`; NEAR `checkCargoNear` | Troca "command not found" por comando copiável | Checar Node ≥ 20.18.3, Yarn/Corepack, e **Docker apenas se o modo local for escolhido** (H8) | **Adotar** |
| **P-04** | **Codegen como etapa do pipeline; saída commitada** | SE2 `generateTsAbis`; SOLT Codama; SUI codegen; STL clients | `lint`/`build` funcionam em clone limpo (gate #19); CI detecta drift | Estender além de contratos (H1) para topic/token — ver REQ-24-01 | **Adaptar** |
| **P-05** | **Hooks tipados por nome de contrato** + **camada de domínio** por cima | SE2 `useScaffold*`; ABI Surf; builders SUI | Autocomplete de função/args; troca de rede transparente | Hooks EVM só cobrem a parte contrato (H1); camada de domínio (`useSettlementRouter`) esconde ABI cru | **Adaptar** |
| **P-06** | **Erros como dado tipado derivado do ABI/IDL** | SOLT Codama `errors/`; SE2 `getParsedErrorWithAllAbis` | Sem tabela manual de erros; mensagem por erro customizado | Solidity custom errors → seletores; **somar** códigos Hedera (H3) e respostas HTS | **Adaptar** |
| **P-07** | **Simulação antes do prompt da wallet** | SE2 `simulateContractWriteAndNotifyError` | Revert aparece antes de gastar tempo/gas | Relay devolve `code 3` com razão [E]; comportamento de `eth_call` com chamadas HTS **[NV]** — testar no #9 | **Adaptar** |
| **P-08** | **Ciclo de vida explícito com link de explorer em cada estágio** | OK `useGetTransactionStatusLabel`; SE2 `TxnNotification`; SOLT toasts | UI é projeção de estado, testável; usuário sabe "onde parou" | Estender com estados Hedera (HCS, indexação do Mirror) — REQ-12-01 | **Adaptar** |
| **P-09** | **Um único módulo de links de explorer por rede** | SOLT `explorer.ts`; SE2 `getBlockExplorerTxLink`; HBAR (`account` vs `address`) | Sem `href` montado à mão em componentes | Precisa suportar Transaction ID **e** hash, conta, contrato, token, tópico (H2) | **Adaptar** |
| **P-10** | **Configuração de rede em um só lugar** consumida por hardhat, Next e SDK | STL `environments.toml`; SE2 `scaffold.config.ts` | Elimina a triplicação observada no HBAR ([2.2](#baseline)) | Módulo TS em `packages/sdk` com chainId, RPC, Mirror, HashScan por ambiente (295/296/298) | **Adaptar** |
| **P-11** | **Debug de contratos: reutilizar, não reescrever** | SE2/HUI `debug-contracts`; STL removeu o seu | Mantém foco no fluxo de domínio (#12) | Herdar `/debug` do base; HUI resolve H5 | **Adotar** |
| **P-12** | **Rede errada = ação, não só aviso** | SE2 `WrongNetworkDropdown`; HBAR `LocalChainErrorBanner` (auto-troca p/ testnet); APT modal | Elimina o "por que não funciona?" | Preferir banner + botão de troca + desabilitar ações; **não** modal bloqueante (impede ler o dashboard #11) | **Adaptar** |
| **P-13** | **Primeiro run funcional com recurso de referência** | NEAR `hello.near-examples.testnet` | App mostra algo útil antes de qualquer deploy/fundos | Manifesto de deployments **de referência** (Testnet) + modo somente leitura; **risco H7**: reset da testnet invalida IDs → detectar e explicar | **Adaptar** |
| **P-14** | **Repositório pronto para agentes de IA** | SE2 `AGENTS.md`+`.cursor/.claude/.agents`; STLUI `CLAUDE.md`; SOLT `skills`; HUI MCP | Reduz alucinação; também é critério RUB-02 do bounty | Já é gate (GATE-11); manter **sincronizado com scripts reais** (verificação em CI) | **Adotar** |
| **P-15** | **Deployer com keystore criptografado** | SE2/HBAR `runHardhatDeployWithPK` | Chave nunca em texto puro no disco | Não funciona em CI não interativo → permitir chave via secret store **somente em CI** | **Adaptar** |
| **P-16** | **Burner wallet só em rede local/dev** | SE2 `burnerWalletMode`; SUI `import.meta.env.DEV` | Evita fundos reais em chave descartável | Em testnet o burner exige financiamento manual (H7) → *opt-in* explícito | **Adaptar** |
| **P-17** | **Testes para o código de DX** | STK `__tests__` por hook; OK (cobertura) | O código que "explica" erros é onde regressões passam despercebidas | Casa com RUB-03 ("meaningful tests") e #13 | **Adotar** |
| **P-18** | **Conversão de unidades centralizada** | HUI `IntegerInput`/`HbarInput` | H5 é fonte real de bug | Reusar HUI; testes de fronteira 8↔18 casas | **Adotar** |

---

## 7. Anti-padrões a evitar <a id="antipadroes"></a>

| ID | Anti-padrão | Onde observado | Dano | Regra para o Scaffold-HBAR |
|---|---|---|---|---|
| **A-01** | **Chaves/IDs compartilhados commitados como default** (Alchemy, WalletConnect) | SE2 `scaffold.config.ts`; HBAR (WalletConnect) [E] | Falha em scanners de secrets (gate "no committed secrets"), rate limit compartilhado, dependência oculta de terceiros | Valores **vazios** no repositório; dashboard mostra "não configurado"; nada dependente de chave compartilhada |
| **A-02** | **Chave privada em `.env` gerado pelo scaffolder com prefixo exposto ao cliente**; e **chave de teste conhecida como fallback** | APT `VITE_MODULE_PUBLISHER_ACCOUNT_PRIVATE_KEY`; SE2/HBAR fallback Hardhat #0 em `hederaTestnet` [E] | Vazamento para bundle; chave pública conhecida sendo usada em rede pública | Variáveis com segredo **só server-side** (nunca `NEXT_PUBLIC_*`); validador (#5/#17) falha se detectar; **falhar** (não usar fallback) em rede ≠ local |
| **A-03** | **Passo manual pós-deploy para atualizar constantes** | SUI `constants.ts` (`TODO`) | Exatamente o atrito que #24 elimina | Codegen escreve o manifesto; nenhuma constante de endereço em código |
| **A-04** | **`sleep` fixo para consistência eventual** e `.then` sem `.catch` | APT `get_abi.js`, `publish.js` | Flaky (dorme pouco/muito) e falhas silenciosas | Polling com backoff e timeout + estado "aguardando Mirror Node" (#10, REQ-12-05) |
| **A-05** | **Atualização otimista sem rollback** | NEAR `hello-near/page.tsx` | UI mente sobre o estado on-chain | Em fluxo verificável a UI mostra **estado confirmado**; estados intermediários são rotulados como pendentes |
| **A-06** | **Mensagem genérica de falha** | SUI ("Transaction failed"); SE2/HBAR fallback "An unknown error occurred"; HBAR `getParsedError` ignora H3 | Usuário não sabe se tenta de novo, muda rede ou corrige fundos | Toda falha tem `kind` + causa + remediação; "desconhecido" exibe **código e mensagem brutos** |
| **A-07** | **Erro somente em toast efêmero** | SE2 `notification.error` | Erro some; jurado não vê; sem evidência | Painel persistente de log do fluxo com "copiar detalhes"; toast é complemento |
| **A-08** | **Telemetria sem consentimento claro** | APT (GA4, sem prompt encontrado); vs. NEAR (divulga) e OK (pergunta) | Erosão de confiança; risco em avaliação | O template **não faz chamadas de rede fora do necessário**; nenhum `postinstall` que "liga para casa" |
| **A-09** | **Construir explorer/debugger genérico dentro do template** | SE2 `app/blockexplorer/*`; STL removeu o seu | Custo de manutenção alto e fora do valor do caso de uso | Reusar `/debug` do base (P-11) e **linkar HashScan**; console focado no fluxo de domínio |
| **A-10** | **Mainnet entre as redes padrão de um template de testnet** | HBAR `targetNetworks` inclui `hedera`; SOLT seletor com mainnet | Gasto real acidental; contraria o foco em Testnet | `targetNetworks = [testnet, local]`; mainnet só por flag explícita + checklist (`docs/deployment.md`) |
| **A-11** | **Infra local pesada como caminho padrão** | STL (Docker); LNODE (16 GB RAM, 6 CPUs) [E] | Elimina quem tem máquina modesta; falha no gate #19 | Padrão = Testnet + mock determinístico; local **opcional** |
| **A-12** | **Mock que parece integração** | Risco descrito em #8/#23; RUB-01 | Perde pontos de Ecosystem Integration | Distintivo visual permanente "MOCK ORACLE (teste)" vs "Oracle: `<provedor>` (real)" na UI e nas evidências |
| **A-13** | **Manifesto inválido sem falha ruidosa** | CSH cai em padrões permissivos ([bounty-rules D-01](bounty-rules.md#divergencias)) | Template "funciona" com menus errados e ninguém percebe | Teste de CI valida `template.json` contra o schema do CSH |
| **A-14** | **Scripts com semântica contraintuitiva e docs que não são verificadas** | HBAR: `start` = `next dev` e `serve` = `next start` (o inverso da convenção do npm); README depende disso (`yarn next:start`) | Risco no gate ("start funcionando"): um avaliador que rode `yarn start` esperando produção, ou um comando citado que não exista, reprova | Semântica documentada e **verificada em CI**: todo script citado em README/AGENTS.md existe e roda (REQ-04-05) |

---

## 8. Comportamentos úteis lá que **não** fazem sentido aqui <a id="nao-aplicavel"></a>

| ID | Comportamento | Origem | Por que não se transfere para Hedera / este caso de uso |
|---|---|---|---|
| **N-01** | **Botão de airdrop / faucet local instantâneo** | SOLT airdrop; STLUI `FundAccountButton` (Friendbot); SE2 Faucet local | Funding de testnet Hedera exige registro no Portal (H7); não há API equivalente no fluxo. **Substituir por**: guia + link para o faucet + polling de saldo + detecção de reset de testnet. |
| **N-02** | **Block explorer embutido** | SE2 `blockexplorer` | Existe HashScan (e HashScan local no Local Node [E LNODE]); manter um explorer é custo sem valor (A-09). |
| **N-03** | **Multicall/escrita atômica em múltiplos calls** | STK `useScaffoldMultiWriteContract` | HCS não é chamável do EVM (H1); não há atomicidade entre HCS e contrato. O fluxo é **sequencial com correlação por chave de idempotência** (#3/#9) — máquina de estados, não multicall. |
| **N-04** | **Hot reload = redeploy automático a cada save** | SE2 ("Contract Hot Reload"), STL `watch` | Em Testnet cada deploy custa HBAR e tempo, e altera IDs/manifesto. Redeploy contínuo só em rede local; em Testnet, deploy **explícito**. Regeneração de tipos (sem deploy) pode ser automática. |
| **N-05** | **Contagem de confirmações de bloco como sinal de "concluído"** | SE2 `blockConfirmations` | O sinal relevante aqui é **recibo do relay + indexação no Mirror Node** (H6) **[I]**. |
| **N-06** | **Objetos/recursos (Sui/Aptos), PDAs (Solana), passphrase (Stellar), contas keyless (Aptos exemplo)** | APT, SUI, SOLT, STL | Modelos de conta/estado específicos; a Hedera é EVM + serviços nativos. Não identifiquei equivalente oficial de contas keyless em Hedera **[NV]**. |
| **N-07** | **Provedor RPC comercial "default" (Alchemy)** | SE2 | Hashio é o RPC público de Hedera, **só para dev/teste** (H4) — a solução é configuração por env + aviso de rate limit, não embutir chave. |
| **N-08** | **Seletor de rede com mainnet ao lado de testnet** | SOLT, HBAR | Ver A-10. |
| **N-09** | **Verificação de contrato por API Etherscan** | SE2 `verify` | Hedera usa Sourcify (H10); o base já resolve. |

---

## 9. Sensibilidade à decisão da issue #21 <a id="sensibilidade-21"></a>

A issue #21 está **aberta**: a arquitetura de Settlement é premissa, não decisão fechada. Os requisitos abaixo foram separados por dependência:

| Grupo | Requisitos | Se #21 mudar para RWA ou AI Agent |
|---|---|---|
| **Independentes do caso de uso** (infra de DX) | REQ-04-01…06, REQ-24-01…04/06…08, REQ-11-01…05, REQ-12-03 (taxonomia base), REQ-12-04 | Permanecem integralmente |
| **Dependentes do fluxo Settlement** | REQ-12-01/02/05/06/08 (etapas oracle→HCS→contrato→HTS→auditoria) | Trocar as **etapas** da máquina de estados. RWA: emissão → conformidade → transferência/distribuição. AI Agent: intenção → decisão → ação → atestado. O **mecanismo** (estados + dois identificadores + Mirror) permanece |
| **Dependentes de HCS** (H1) | REQ-24-02 (topic no manifesto), REQ-12-02 (mensagem HCS sem hash EVM) | RWA sem HCS: manter só o que for usado. AI Agent: HCS provavelmente central (log de decisões) |

**Risco de duplicação** (citado em #21): o console (#12) é a peça mais avaliada por jurados (issue #12). Investir em REQ-12-01/03/05 gera vantagem **independentemente** de qual direção prevaleça, pois nenhum scaffold analisado modela "aguardando indexação" nem classifica erros do relay Hedera.

---

## 10. Requisitos concretos por issue

**Formato de cada requisito:** ID · *Motivador* (padrão de mercado, com ID da [seção 6](#padroes)/[7](#antipadroes)) · *Referência* (scaffold) · *Adaptação Hedera* · *Critério de aceite verificável* · **Prioridade** — `MUST` (impacta o gate do bounty ou a issue não fecha sem isso), `SHOULD` (impacta a rubrica RUB-01…04 de forma clara), `COULD` (polimento).

Ligação com [bounty-rules.md](bounty-rules.md): `GATE-xx` e `RUB-xx` citados abaixo referem-se àquele documento.

### #4 — scaffold: adotar convenções do template oficial <a id="req-04"></a>

| ID | Requisito | Motivador · Referência | Adaptação Hedera | Aceite | Prio |
|---|---|---|---|---|:-:|
| **REQ-04-01** | `template.json` **válido contra o schema do CSH** (`name` obrigatório; `capabilities` = `nextjs-app`/`hardhat`/`yarn`; `defaults`) **+** `outro.sections` com "próximos passos" reais **+** `envVars` (gera `.env.example` com descrições) | P-02, A-13 · SOLT `instructions`/`versions`; HBAR `templates/*` (`outro`); CSH `types.ts` (`envVars`) | **Implementado em #4.** `requirements` foi **retirado**: o schema o aceita mas o CLI 0.4.0 nunca o lê ([scaffold-compat.md](scaffold-compat.md) DV-2). O manifesto anterior **não tinha `name`** e **derrubava** o CLI ([bounty-rules D-01](bounty-rules.md#divergencias)). Revalidar contra a versão vigente do CSH perto da submissão (#19) | Teste de CI que carrega `template.json` com o schema do CSH (cópia versionada do schema, ou pacote se exportado **[NV]**) e falha se inválido; `npm create … --template` exibe o `outro` | MUST |
| **REQ-04-02** | **Um único módulo de configuração de rede** em `packages/sdk` (chainId 296/295/298, RPC, Mirror, HashScan, por ambiente) consumido por `hardhat.config.ts`, Next e SDK | P-10 · STL `environments.toml`; SE2 `scaffold.config.ts` | Remove a triplicação do base ([2.2](#baseline)); RPC Hashio é dev-only (H4) → variável de override documentada | `grep` no repositório não encontra URL de RPC/Mirror fora do módulo (teste de CI); mudar `HEDERA_NETWORK` altera os três consumidores | MUST |
| **REQ-04-03** | **Um único esquema de variáveis de ambiente** (validado por schema, com descrição) e nomes reconciliados: hoje coexistem `HEDERA_PRIVATE_KEY` e `HEDERA_OPERATOR_KEY` no `.env.example`, e nomes divergentes do base (`HEDERA_MIRROR_NODE_URL` vs `HEDERA_MIRROR_TESTNET_URL`, `DEPLOYER_PRIVATE_KEY_ENCRYPTED`) | A-01, A-02, P-15 · APT `setUpEnvVariables`; SE2 keystore | **Segredos nunca com prefixo `NEXT_PUBLIC_`**; deployer via keystore criptografado; operator key do SDK **só server-side**; **sem** fallback para chave conhecida fora de rede local; sem WalletConnect/Alchemy default | `.env.example` gerado do schema; teste falha se qualquer variável `NEXT_PUBLIC_*` casar com padrões de chave/segredo; `hardhat deploy --network hederaTestnet` **falha** sem chave (não usa Hardhat #0) | MUST |
| **REQ-04-04** | **`doctor` + `setup` fail-fast**: `yarn doctor` (Node ≥ 20.18.3, Corepack/Yarn, e Docker **apenas** se modo local), `yarn setup` = doctor → validar conta/rede/saldo (#5) → compile → deploy → codegen (#24). Executado em `predev`/`prestart` como guard | P-01, P-03 · STL `dev-guard.mjs`; SOLT `setup`+`versions`; NEAR `checkCargoNear` | Saldo insuficiente ⇒ imprime link do faucet (`portal.hedera.com/faucet`) e **espera por polling** com timeout (H7); mensagens distinguem env ausente / conta inválida / saldo / rede (aceite de #5) | Em máquina sem `.env`: `yarn setup` termina com **código ≠ 0** e mensagem com **comando exato** de remediação; com `.env` válido e saldo, completa sem prompts (exceto senha do keystore) | MUST |
| **REQ-04-05** | **Scripts raiz com semântica explícita e verificados**: `dev` (Next dev), `start` (ver nota), `build`, `lint`, `check` (lint+typecheck+test), `setup`, `doctor`, `chain` (opcional), `deploy`, `codegen`, `verify:testnet`. **CI verifica que todo script citado em `README.md`/`AGENTS.md` existe** | A-14, P-14 · SE2 aliases curtos (`chain`, `deploy`); HBAR prefixos (`hardhat:*`) | Base usa `start` = dev e `serve` = produção. **Recomendação:** manter `start` = servidor **que sobe em clone limpo sem build prévio** (compatível com o gate GATE-18 e com a convenção do base) e documentar `serve` para produção; ambos exercitados pelo self-check (#14). A ambiguidade de qual comando o juiz roda é [bounty-rules D-11](bounty-rules.md#divergencias) | Script de CI extrai comandos de README/AGENTS.md e executa `yarn <script> --help`/dry-run; falha se algum não existir | MUST |
| **REQ-04-06** | **Caminho padrão = Testnet + oracle mock determinístico**; forking e Local Node **opcionais** e documentados (com aviso: forking só emula HTS; Local Node exige ~16 GB RAM e ocupa a porta 3000 — conflito com `next dev`) | A-11 · STL (Docker) como contraexemplo; STK Dev Containers | H8: nenhuma opção local cobre o fluxo inteiro de forma leve; HCS não é emulado pelo forking | `yarn setup && yarn dev` funciona **sem Docker**; documentação lista pré-requisitos do modo local separadamente | SHOULD |
| **REQ-04-07** | **Zero telemetria/chamadas externas ocultas** em scripts do template (`postinstall`, `setup`) além de Hedera/Mirror/oracle configurado | A-08 | — | Auditoria de `scripts` e `postinstall`; lista de hosts acessados documentada em `docs/integration.md` | SHOULD |
| **REQ-04-08** | `AGENTS.md` regenerado **depois** dos scripts reais existirem, com: comandos, nomes corretos de hooks, armadilhas (limite de gas em deploy, decimais 8×18, Mirror eventual) | P-14 · SE2 `AGENTS.md` (nomes "corretos" de hooks, gotcha de gas) | Incluir H1 (HCS não é EVM) e H2 (dois IDs) | Revisão contra REQ-04-05; conteúdo cobre 3 armadilhas Hedera | SHOULD |

### #24 — dx: propagação automática de ABI/endereços (codegen) <a id="req-24"></a>

| ID | Requisito | Motivador · Referência | Adaptação Hedera | Aceite | Prio |
|---|---|---|---|---|:-:|
| **REQ-24-01** | **Manifesto de deployments versionado** por rede em `packages/sdk/generated/`: `schemaVersion`, `network`, `chainId`, e para cada contrato: `name`, `address` (EVM), **`contractId` (0.0.x)**, `deployTxHash`, **`deployTransactionId`**, `hashscanUrl`, `verified` (Sourcify), `abiHash`, `deployedAt` | P-04 · SE2 `deployedContracts.ts` (só endereço/ABI); HBAR hook no `deploy` | **Acrescentar Contract ID e Transaction ID** (H2) e link HashScan; base só guarda EVM address | Após `yarn deploy --network hederaTestnet`, o arquivo contém os campos acima sem edição manual (aceite de #24) | MUST |
| **REQ-24-02** | O mesmo manifesto carrega **recursos não-contrato**: `hcsTopicId` e `htsTokenId` (com link HashScan e transaction ID de criação), escritos pelos scripts de #5/#6/#7 | P-04 · (nenhum scaffold analisado cobre isso) | H1: HCS/HTS-nativo não passam por EVM; sem isso o dashboard (#11) e o console (#12) teriam de ler env/hardcode | Após `yarn setup`, `hcsTopicId`/`htsTokenId` presentes; #11 não lê nenhum ID de `process.env` para exibi-los | MUST |
| **REQ-24-03** | **Erros derivados do ABI**: o codegen emite `errors.ts` com seletor → `{name, signature, contract, humanMessage}` (`humanMessage` de `@custom:`/NatSpec quando houver) | P-06 · SOLT Codama `getVaultErrorMessage`; SE2 `getParsedErrorWithAllAbis` | Somar dicionário de **códigos de resposta Hedera/HTS** usado por `classifyError` (REQ-12-03). Como falhas HTS surgem no contrato (retorno vs revert) é **[NV]** → decidir e testar em #7/#9 (custom error carregando o código) | Teste: dado o seletor de `ReplayDetected` (#9), `classifyError` devolve o nome e mensagem sem consultar tabela manual | MUST |
| **REQ-24-04** | **Hooks em duas camadas**: (1) genéricos tipados por nome (`useScaffoldRead/WriteContract`, herdados do base); (2) **hook de domínio** `useSettlementRouter()` expondo verbos (`submitSettlement`, `getSettlement`), não funções do ABI. A parte **HCS/orquestração** **não** é hook wagmi: é rota server (`/api/settlement/*`) consumida por `useSettlementFlow()` (#12) | P-05 · SE2 hooks; APT Surf; SUI builders | H1: o hook de contrato só cobre a etapa EVM; não vender "um hook faz tudo" | `useSettlementRouter()` usado por #12 em vez de `Contract` manual (aceite de #24); nenhum `new Contract(`/`getContract(` com endereço literal fora do SDK (teste de lint) | MUST |
| **REQ-24-05** | **Falha ruidosa e acionável** quando falta deployment na rede atual: mensagem cita **rede, chainId e comando** (`yarn deploy --network hederaTestnet`); o mesmo texto é reutilizado pelo dashboard (#11) | P-12 · SE2 "did you forget to run `yarn deploy`?" | Base cita comandos genéricos; incluir nome da rede Hedera | Teste do hook sem deployment na 296 retorna a mensagem esperada | SHOULD |
| **REQ-24-06** | **Pós-deploy**: imprimir e gravar links HashScan (contrato e tx), executar verificação Sourcify (flag) e registrar `verified` no manifesto | P-09 · HBAR task `verify` (link HashScan) | H10 (Sourcify); gera a evidência exigida por GATE-13/14 e #18 | Saída do `deploy` lista `hashscanUrl` clicável para cada contrato; manifesto tem `verified: true` | SHOULD |
| **REQ-24-07** | **Saída gerada commitada + verificação de deriva em CI** (`yarn codegen:check` regenera e falha se `git diff` não vazio); arquivos com cabeçalho "autogenerated — do not edit" | P-04 · SE2 (cabeçalho); SOLT (commit da saída) | Clone limpo precisa passar `lint`/`build` **sem deploy** (GATE-15…17) → ABIs/tipos sempre presentes; endereços de **referência** (Testnet) commitados, alteráveis por deploy local | `git clone && yarn install && yarn lint && yarn build` passa sem `.env`; CI falha se codegen desatualizado | MUST |
| **REQ-24-08** | **Testes do gerador** (golden files: dado um artefato de compilação fixo, saída idêntica) e do resolvedor `chainId → deployment` | P-17 · STK (testes de hooks) | — | Testes passam em `yarn test`; cobertura dos ramos "sem deployment" e "rede desconhecida" | SHOULD |
| **REQ-24-09** | Documentar em `docs/integration.md`: diagrama do pipeline (Solidity → compile → ABI → codegen → manifesto → hooks → UI), formato do manifesto (com `schemaVersion`), e o limite explícito **"HCS/HTS-nativo não passam por hooks EVM"** | P-14 | H1 | Seção presente; revisada por alguém que não implementou (RUB-02) | MUST |
| **REQ-24-10** | `codegen --watch` **somente sobre artefatos de compilação** (sem redeploy) | N-04 · STL `watch` | Deploy em Testnet nunca é automático | Comando existe; documentação avisa que deploy é sempre explícito fora de rede local | COULD |

### #11 — frontend: dashboard de ambiente Hedera <a id="req-11"></a>

| ID | Requisito | Motivador · Referência | Adaptação Hedera | Aceite | Prio |
|---|---|---|---|---|:-:|
| **REQ-11-01** | **Fonte de dados única**: rota server `/api/env/status` chama o validador de #5 e devolve `CheckResult[]` = `{ id, label, status: ok \| error \| not_configured \| degraded, detail, remediation, docsUrl?, explorerUrl?, checkedAt }`. **Toda falha traz remediação** (comando ou link). Dashboard **não** reimplementa lógica | P-03, P-12 · STL `dev-guard`; HBAR `LocalChainErrorBanner` (mensagem + comando exato); harness `doctor` | Operator key permanece server-side (A-02); o cliente recebe só resultados | Toda linha com `status ≠ ok` tem `remediation` não vazio (teste); #11 e #14 (self-check) consomem o **mesmo** módulo (aceite de #5) | MUST |
| **REQ-11-02** | **Bloco Rede/Wallet**: wallet conectada (endereço EVM **+ Account ID** resolvido via Mirror — reutilizar `useHederaAccountId`), chainId vs rede-alvo, saldo em HBAR (helper único 8↔18 casas), e **ação de trocar rede** com desabilitação dos botões de ação enquanto errada | P-12, P-18 · SE2 `WrongNetworkDropdown`; HBAR `LocalChainErrorBanner`; HUI `Balance`/`HbarInput` | H5: teste de fronteira; conta EVM sem Account ID ainda (não criada) exibe estado explícito, não "erro" | Trocar a wallet para outra rede muda o estado para "rede errada" com botão de troca; testes do formatador 8/18 casas | MUST |
| **REQ-11-03** | **Recursos**: contratos, tópico HCS, token HTS **lidos do manifesto (REQ-24-01/02)**, cada um com link HashScan e selo `verified`. **Um único módulo `explorer`** com funções para transação (por hash **ou** Transaction ID), conta, contrato, token e tópico | P-09 · SOLT `explorer.ts`; HBAR `getBlockExplorerAddressLink` (`account` vs `address`) | H2/H10. **[NV]** confirmar manualmente as formas de URL aceitas pelo HashScan (`/tx/` vs `/transaction/`, hash vs ID) antes de fixar | Nenhum `href` para HashScan fora do módulo (lint); testes de URL por tipo/rede; sem endereços hardcoded (DoD de #11) | MUST |
| **REQ-11-04** | **Cards de saúde** com os 4 estados: **oracle** (mock vs real, ver REQ-12-08), **HCS** (tópico legível no Mirror; publicação possível se operator configurado), **HTS** (token existe; associação do tesouro/destinatário), **Mirror Node** (latência e último timestamp de consenso), **RPC** (`eth_chainId` = alvo; detecta `-32606`/rate limit → estado `degraded`). Verificações **somente leitura**, com timeout e intervalo mínimo entre polls | P-08 · (nenhum scaffold analisado tem painel de saúde) | H3/H4: relay público limita; `degraded` ≠ `error`. Não fazer transações reais no health check | Cada um dos 4 estados é alcançável em teste com fixtures (#13); dashboard renderiza sem `.env` (todos `not_configured`) com **HTTP 200** (GATE-18) | MUST |
| **REQ-11-05** | **Painel de onboarding Testnet**: link do faucet, saldo mínimo recomendado × custo estimado do fluxo, e detecção de **"conta não encontrada"** com texto sobre **reset de testnet** (IDs mudam, chaves permanecem) | N-01 · SOLT airdrop; STLUI `FundAccountButton` | H7: **não** automatizar; guiar. Sem botão que promete fundos | Simular conta inexistente (404 do Mirror) → mensagem cita faucet e reset | SHOULD |
| **REQ-11-06** | **Modo referência** (somente leitura): sem wallet/saldo, exibir recursos e a última liquidação de **referência** do manifesto (evidência #18) | P-13 · NEAR contrato pré-implantado | H7: se os IDs de referência não existirem mais (reset), estado explica e aponta para evidência arquivada | Abrir `/dashboard` sem wallet mostra recursos de referência; com IDs inválidos mostra aviso, não crash | SHOULD |
| **REQ-11-07** | **"Copiar diagnóstico"**: JSON redigido (sem segredos) com `CheckResult[]`, versões e rede | P-03 [I] · harness `doctor` | — | Nenhum campo de segredo no JSON (teste) | COULD |
| **REQ-11-08** | **Não** construir explorer nem debug genérico; `/debug` do base permanece e é linkado do dashboard | A-09, P-11 · STL (removeu o seu) | HashScan cobre exploração | Sem rotas `blockexplorer/*` no template; link para `/debug` presente | SHOULD |

### #12 — frontend: developer console de settlement <a id="req-12"></a>

| ID | Requisito | Motivador · Referência | Adaptação Hedera | Aceite | Prio |
|---|---|---|---|---|:-:|
| **REQ-12-01** | **Máquina de estados do fluxo**, tipada no SDK e compartilhada com #10: `idle → oracle_fetching → hcs_publishing → hcs_confirmed → contract_pending_wallet → contract_submitted → contract_confirmed → hts_settled → audited`, além de `failed(kind)`. Cada etapa guarda `status`, `startedAt`, identificadores, `explorerUrl`, `error?`. UI = **projeção** do estado (stepper) | P-08 · OK ciclo `buildingTransaction → transactionPending → in progress → success` | Etapas próprias de Hedera: HCS e **indexação** do Mirror (H1, H6) | Teste de unidade percorre todas as transições e as falhas; UI mostra a etapa exata em que parou (aceite de #12: "operações, logs, eventos") | MUST |
| **REQ-12-02** | **Dois identificadores por etapa**: Transaction ID (`0.0.x@s.n`) **e** hash EVM quando existir; mensagem HCS mostra `topicId`, `sequenceNumber`, `consensusTimestamp` e Transaction ID (sem hash EVM). Ao final: "Transaction completed — Transaction ID: … — View on Hashscan" | P-08, P-09 · SE2 `TxnNotification`; OK `TransactionToast` ("View transaction"); SOLT toasts | H2. Links pelo módulo de REQ-11-03 | Cada etapa concluída exibe link HashScan funcional (checagem manual em #18) e o tipo de ID correto | MUST |
| **REQ-12-03** | **`classifyError(unknown): SettlementError`** — função pura no SDK, tabelada. `SettlementError = { kind, code?, userMessage, remediation, retryable, technical, cause }`. `kind` cobre no mínimo os seis cenários de #12 e os derivados dos códigos reais: `wallet_disconnected`, `wallet_rejected`, `wrong_network`, `rpc_timeout` (`-32010`), `rpc_rate_limited` (`-32606`/IP), `mirror_upstream` (`-32020`), `tx_rejected` (`-32003` com `data.hederaStatus`, `transactionId`, `provisional`), `insufficient_funds` (`-32000`), `gas_price_too_low` (`-32009`), `contract_revert` (código `3` + erro customizado decodificado, REQ-24-03), `hts_error` (não associado, saldo, token inválido — #7), `hcs_error` (tópico inválido/timeout — #6), `oracle_unavailable`, `unknown_rpc` (exibe **código e mensagem brutos**) | P-06, A-06 · SOLT `parseTransactionError` (percorre `cause`, trata "User rejected"); SE2 `getParsedError(WithAllAbis)`; OK `isUserRejectedRequestError`; **RELAY** `JsonRpcError.ts` | Catálogo de códigos vem de RELAY (H3). Classificar por **código e por padrão de mensagem** (versões do relay variam **[NV]**); `provisional: true` ⇒ estado `pending_finality`, não erro definitivo | **Matriz de testes com uma fixture por `kind`** (#13); os 6 cenários de #12 produzem mensagens **distintas**; nenhum caminho devolve "erro desconhecido" sem código bruto | MUST |
| **REQ-12-04** | **Simulação antes da wallet** (`eth_call`) para exibir revert com razão antes do prompt; permitir override de gas e explicar `GAS_LIMIT_TOO_LOW` | P-07 · SE2 `simulateContractWriteAndNotifyError` (com flag `disableSimulate`) | Relay devolve revert com razão [E]; **[NV]** se `eth_call` reflete estado HTS/chamadas a `0x167` como on-chain — validar em #9 | Replay proposital (mesmo evento 2×) mostra o revert `ReplayDetected` antes de assinar | SHOULD |
| **REQ-12-05** | **Estado "aguardando indexação do Mirror Node"** como etapa própria (polling com backoff e timeout, mensagem "confirmado no relay, aguardando Mirror Node"), **nunca** tratar 404 inicial como falha | A-04, A-05 · APT (`sleep` fixo, contraexemplo); SUI `waitForTransaction` | H6: nenhum scaffold analisado modela isso — **diferencial** | Com Mirror simulado atrasado, UI passa por "aguardando" e conclui; com timeout mostra erro específico `mirror_timeout` | MUST |
| **REQ-12-06** | **Painel persistente de log** (não apenas toast): cada evento do fluxo com timestamp, etapa, ids, "detalhes técnicos" expansível (JSON bruto) e **copiar**. Toasts são complemento | A-07, P-08 · SE2 (toast-only, contraexemplo); OK status inline | Serve de evidência para jurados/#18 | Erros permanecem visíveis após recarregar a etapa; botão copiar contém `technical` e `cause` (sem segredos) | MUST |
| **REQ-12-07** | **Eventos e auditoria correlacionados** (evento do contrato + mensagem HCS + transferência HTS) reutilizando a timeline de #10; `/debug` do base linkado por contrato | P-11 · SE2 `useScaffoldEventHistory`; base `/debug` | H2/H6 | "dados de transação e Mirror Node visíveis" (aceite de #12) para uma execução real | MUST |
| **REQ-12-08** | **Distintivo permanente** de origem do dado: `MOCK ORACLE (teste)` vs `Oracle: <provedor> (real)`; nas capturas/evidência (#18/#20) o distintivo aparece | A-12 · risco RUB-01 em #8/#23 | — | Snapshot de UI em modo mock e real difere; documentado em `docs/integration.md` | MUST |
| **REQ-12-09** | **Modelo de assinatura v1 documentado (ADR)**: contrato via **wallet EVM** (wagmi/relay, reutiliza hooks e codegen); publicação **HCS e operações nativas via server (SDK) com operator key**; wallet **nativa** (`hedera:testnet`, HashPack) **fora do escopo v1** | H9 · HWC (dois namespaces) | Trade-off: o servidor é o "oracle adapter" com chave própria (alinha a #3); reduz superfície de erro e de teste. Registrar no ADR de #3/#21 | ADR com a decisão; `SettlementError` cobre apenas os caminhos suportados | SHOULD |
| **REQ-12-10** | **Testnet por padrão; mainnet inalcançável sem flag explícita** (`targetNetworks = [testnet, local]`) | A-10, N-08 | `docs/deployment.md` já exige checklist para mainnet | Sem seletor de mainnet na UI padrão; teste de config | SHOULD |
| **REQ-12-11** | **E2E sem wallet interativa**: modo "signer de dev" **somente** para CI/E2E (#15), com oracle mock determinístico e `data-testid` nas etapas | P-17 · (nenhum scaffold analisado oferece) | Chave de teste vem de secret de CI (nunca commitada, A-02) | E2E cobre sucesso, replay, RPC indisponível e wallet desconectada | SHOULD |

### Impactos secundários em outras issues

| Issue | Ajuste decorrente do benchmark |
|---|---|
| **#5** validador de ambiente | Retornar `CheckResult[]` estruturado (REQ-11-01); aguardar saldo por polling (REQ-04-04); rejeitar `NEXT_PUBLIC_*` com segredo (REQ-04-03) |
| **#6** HCS | Persistir Transaction ID, `topicId`, `sequenceNumber`, `consensusTimestamp`; erros mapeáveis a `hcs_error` (REQ-12-03); gravar `hcsTopicId` no manifesto (REQ-24-02) |
| **#7** HTS | Dicionário de códigos de resposta HTS e como chegam ao contrato (REQ-24-03); gravar `htsTokenId` no manifesto |
| **#9** contrato | Custom errors com NatSpec (REQ-24-03); evento por etapa (#12); validar `eth_call` com HTS (REQ-12-04) |
| **#10** auditoria | Tipos da timeline e `waitForIndexing` compartilhados com a máquina de estados (REQ-12-01/05) |
| **#13** testes | Fixture por `kind` de erro; testes de gerador, de `explorer`, de conversão 8↔18 (P-17) |
| **#14** self-check/CI | `codegen:check`, validação de `template.json`, verificação de scripts citados na doc, uso do mesmo módulo do dashboard |
| **#15** E2E | REQ-12-11 |
| **#16** docs | REQ-24-09, REQ-04-08 |
| **#17** segurança | REQ-04-03, A-01/A-02 |
| **#19** fresh scaffold | REQ-04-01/05; testar as duas formas do comando `npm create` ([bounty-rules D-02](bounty-rules.md#divergencias)) |
| **#25** harness | P-14: se usado, `validators` devem incluir "scripts citados existem" e "sem `NEXT_PUBLIC_` com segredo" |

---

## 11. Respostas às perguntas-guia <a id="respostas-guia"></a>

**1. O que um desenvolvedor deve receber automaticamente após criar o projeto?**
Um clone que passa `install`, `lint` e `build` **sem `.env` e sem deploy** (REQ-24-07); ABIs e tipos gerados e commitados; manifesto de deployments **de referência** em Testnet; `AGENTS.md` alinhado aos scripts; `template.json` com "próximos passos" (REQ-04-01); dashboard que abre em HTTP 200 mostrando "não configurado" com o comando de remediação (REQ-11-01/04); `.env.example` gerado do schema (REQ-04-03); `yarn setup` / `yarn dev` como caminho de dois comandos (REQ-04-04).

**2. Quais tarefas não devem exigir configuração manual?**
Copiar ABI/endereço/IDs (REQ-24-01/02); montar links de explorer (REQ-11-03); escolher URL de RPC/Mirror em três lugares (REQ-04-02); descobrir por que falta saldo (REQ-04-04); identificar a rede errada da wallet (REQ-11-02). *Continuam manuais, por H7:* obter HBAR no faucet do Portal e fornecer a senha do keystore.

**3. Quais abstrações realmente melhoram a produtividade?**
As que **removem uma classe inteira de erro**: hooks tipados por ABI (SE2), erros derivados do ABI (Codama), construtor único de explorer (Solana), ciclo de vida de transação como estado (OnchainKit), configuração de ambiente única (Stellar). Não compensam: multicall (N-03), explorer embutido (N-02), redeploy automático em rede pública (N-04).

**4. Como contratos e tipos devem chegar ao frontend?**
Solidity → compile → ABI → **codegen** → manifesto versionado (`packages/sdk/generated/`, com EVM address **e** Contract ID, e topic/token) → hooks tipados por nome → hook de domínio `useSettlementRouter()`. HCS e operações nativas **não** passam por esse caminho: são rota server + SDK (REQ-24-01…04, H1).

**5. Como apresentar erros de wallet, RPC e rede?**
Com `classifyError` (REQ-12-03): cada erro tem `kind`, causa, remediação e se é retentável; wallet rejeitada, desconectada e rede errada são estados distintos; rate limit e timeout do relay são `degraded/retryable`; `-32003` mostra `hederaStatus` e Transaction ID; "desconhecido" mostra o código bruto. Persistir no log (REQ-12-06), não só em toast.

**6. Como facilitar o debug de contratos e transações?**
Herdar `/debug` do base (P-11), simular antes da wallet (REQ-12-04), decodificar custom errors a partir do ABI (REQ-24-03), expor "detalhes técnicos" copiáveis (REQ-12-06) e linkar HashScan em cada etapa (REQ-12-02).

**7. Como integrar HashScan/Mirror Node ao fluxo?**
HashScan por **um** módulo de links (REQ-11-03), em toda etapa concluída (REQ-12-02), gravado no manifesto no deploy (REQ-24-06). Mirror Node como **sinal de fim** do fluxo e etapa própria da máquina de estados (REQ-12-05), e como fonte do painel de saúde (REQ-11-04).

**8. Quais comportamentos úteis fora não fazem sentido em Hedera?**
[Seção 8](#nao-aplicavel): airdrop instantâneo (N-01), explorer embutido (N-02), multicall atômico (N-03), hot-reload com redeploy (N-04), confirmações de bloco (N-05), modelos de conta de outras cadeias (N-06), RPC comercial embutido (N-07), mainnet ao lado de testnet (N-08), Etherscan API (N-09).

---

## 12. Decisões que exigem ratificação e perguntas abertas <a id="abertas"></a>

**Decisões propostas (precisam de aceite explícito antes de virarem escopo):**

1. **Testnet como caminho padrão; local opcional** (REQ-04-06) — reduz risco no gate #19, muda o texto atual de `docs/deployment.md`?
2. **`start` = servidor que sobe em clone limpo** (REQ-04-05) — depende de como o self-check (#14) e os juízes executam ([bounty-rules D-11](bounty-rules.md#divergencias)).
3. **Modelo de assinatura v1** (REQ-12-09): server com operator key para HCS/nativo; wallet EVM para contrato; wallet nativa fora do v1. Deve entrar no ADR de #3.
4. **Commitar manifesto de referência da Testnet** (REQ-24-07/REQ-11-06) — depende de aceitar o risco de reset da Testnet (H7) e de arquivar evidências fora da rede (capturas/JSON) para #18/#20.

**Itens não verificados (bloqueiam a decisão correspondente até serem testados):**

| # | Item | Como resolver |
|---|---|---|
| NV-1 | `eth_call` do relay reflete chamadas ao HTS (`0x167`) e permite simular o `SettlementRouter` | Teste no #9 antes de REQ-12-04 |
| NV-2 | ~~Como falhas HTS chegam ao contrato~~ **Resolvido** pelo ADR-001 ([architecture.md](architecture.md), P1/P2): o precompile HTS devolve `responseCode` (o contrato deve checar e reverter) e efeitos HTS são revertidos com o frame do contrato (HIP-206). O erro de contrato é `HtsFailed(op, code)`; falta apenas observar em Testnet (experimento X-02) | Alimenta REQ-24-03 |
| NV-3 | Formas de URL do HashScan aceitas (`/tx/` vs `/transaction/`; hash vs Transaction ID) | Abrir manualmente exemplos de Testnet antes de fixar REQ-11-03 |
| NV-4 | Se o schema de `template.json` do CSH é importável como pacote | Inspecionar o pacote npm publicado; senão, cópia versionada |
| NV-5 | Códigos do relay variam por versão do Hashio | `classifyError` por código **e** mensagem + fallback bruto |
| NV-6 | Requisitos numéricos do Local Node (16 GB etc.) | Reconferir na doc antes de publicá-los no README |
| NV-7 | Consentimento de telemetria do `create-aptos-dapp` (não encontrado nos arquivos lidos) | Rodar o CLI e observar; irrelevante para o template, relevante ao juízo do anti-padrão A-08 |

**Revalidação:** o benchmark reflete **2026-09-18**. Antes de fechar #4 e #24, reconferir SHAs de CSH/HBAR (mudança de schema ou de scripts base altera REQ-04-01/05 e REQ-24-01).

---

## Anexo — Fontes e SHAs <a id="anexo-fontes"></a>

Conteúdo lido em **2026-09-18** nos commits `HEAD` abaixo (branch padrão). Caminhos de arquivo citados na [seção 4](#analise) são relativos a cada repositório.

| Chave | Repositório | SHA (data) |
|---|---|---|
| SE2 | <https://github.com/scaffold-eth/scaffold-eth-2> | `6cdf354` (2026-08-27) |
| CE | <https://github.com/scaffold-eth/create-eth> | `aee6c6d` (2026-07-30) |
| HBAR | <https://github.com/hedera-dev/scaffold-hbar> | `5eb46ef` (2026-09-03) |
| CSH | <https://github.com/hedera-dev/create-scaffold-hbar> | `5732f5e` (2026-09-04) |
| HUI | <https://github.com/hedera-dev/scaffold-hbar-ui> | `5af5a77` (2026-06-10) |
| OK | <https://github.com/coinbase/onchainkit> | `25415d7` (2026-09-09) |
| — | <https://github.com/coinbase/build-onchain-apps> (arquivado, 2025-02-05) | — |
| CSD | <https://github.com/solana-foundation/create-solana-dapp> | `e9c1bba` (2026-09-18) |
| SOLT | <https://github.com/solana-foundation/templates> | `9e4bbfc` (2026-09-16) |
| APT | <https://github.com/aptos-labs/create-aptos-dapp> | `97c2e8a` (2026-08-13) |
| SUI | <https://github.com/MystenLabs/ts-sdks> (`packages/create-dapp`) | `59dedfe` (2026-09-16) |
| NEAR | <https://github.com/near/create-near-app> | `ff0fedd` (2026-01-08) |
| STL | <https://github.com/stellar-scaffold/cli> | `e58f9d8` (2026-09-11) |
| STLUI | <https://github.com/stellar-scaffold/ui> | `88bd964` (2026-08-06) |
| STK | <https://github.com/Scaffold-Stark/scaffold-stark-2> | `ae1b689` (2026-08-03) |
| RELAY | <https://github.com/hiero-ledger/hiero-json-rpc-relay> (`src/relay/lib/errors/JsonRpcError.ts`) | `5bb224f` (2026-09-18) |
| FORK | <https://github.com/hashgraph/hedera-forking> | `3c494cd` (2026-05-13) |
| LNODE | <https://github.com/hiero-ledger/hiero-local-node> | `bfb7cc6` (2026-05-28) |
| HWC | <https://github.com/hashgraph/hedera-wallet-connect> | `9798423` (2026-04-14) |

Documentação Hedera consultada: [System smart contracts](https://docs.hedera.com/hedera/core-concepts/smart-contracts/system-smart-contracts) · [JSON-RPC relay](https://docs.hedera.com/hedera/core-concepts/smart-contracts/json-rpc-relay) · [Testnet access](https://docs.hedera.com/hedera/networks/testnet/testnet-access) · [Scaffold HBAR](https://docs.hedera.com/solutions/tools/scaffold-hbar/index).

## Histórico

| Data | Alteração |
|---|---|
| 2026-09-18 | Criação: análise de 9 scaffolds, 18 padrões, 14 anti-padrões, 9 comportamentos não aplicáveis e 37 requisitos mapeados a #4, #24, #11 e #12. |

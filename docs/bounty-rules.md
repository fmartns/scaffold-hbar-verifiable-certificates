# Scaffold-HBAR Template Bounty — Regras Oficiais (fonte central de verdade)

> Este documento consolida as regras oficiais do bounty para orientar **todas** as decisões de escopo do projeto e servir de referência às tarefas de submissão **#19** e **#20**.
> Ele **não altera, flexibiliza nem reinterpreta** nenhuma regra oficial. Onde as fontes divergem ou são omissas, isso está registrado na [seção de divergências](#divergencias) — nenhuma interpretação foi assumida.

| Metadado | Valor |
|---|---|
| Última validação contra as fontes oficiais | **2026-09-18** |
| Próxima validação obrigatória | **Antes da submissão final da tarefa #20** (ver [seção 1.2](#revalidacao)) |
| Prazo final de submissão | **Domingo, 4 de outubro de 2026, 23:59 ET** (ver [seção 2](#prazos)) |
| Idioma | Português; trechos oficiais citados **em inglês, como publicados** |

## Como ler este documento

Três tipos de conteúdo, sempre separados e identificados por prefixo de ID e cor do título:

| Marca | Significado | IDs | Onde |
|---|---|---|---|
| 🔴 **GATE** | Requisito **obrigatório de elegibilidade**. Pass/fail mecânico: se um item falhar, a submissão não chega ao painel e **não concorre a prêmio**. **Não gera pontos.** | `GATE-xx` | [Parte A](#parte-a) |
| 🟢 **RUBRICA** | Critério de **pontuação** (100 pontos), aplicado pelo painel **somente a quem passou no gate**. | `RUB-xx` | [Parte B](#parte-b) |
| ☑️ **CHECKLIST** | Lista **derivada** (não oficial) para validar o projeto item a item antes da entrega. | `CHK-xx` | [Parte C](#parte-c) |

Rótulos de origem usados nas tabelas:

- **[OFICIAL]** — texto ou fato retirado literalmente de fonte oficial (citado entre aspas/blockquote).
- **[DERIVADO]** — decisão ou verificação do projeto **derivada** do texto oficial; não é regra do bounty.
- **[NÃO ESPECIFICADO]** — a fonte oficial não define; registrado para evitar suposições.

---

<a id="fontes"></a>

## 1. Fontes oficiais

### 1.1 Registro de fontes

| ID | Fonte | Link | Usada para |
|---|---|---|---|
| **S1** | Página oficial do bounty (Hedera) | <https://hedera.com/blog/scaffold-hbar-template-bounty/> | Prazos, prêmios, gate, submissão, rubrica, harness. **Fonte primária e prevalente.** |
| **S2** | Documentação Scaffold HBAR (Hedera Docs) — seção de *external templates* | <https://docs.hedera.com/solutions/tools/scaffold-hbar/index> | Comando `--template`, manifesto `template.json`, layout monorepo |
| **S3** | Repositório `hedera-dev/scaffold-hbar` (monorepo base, MIT) | <https://github.com/hedera-dev/scaffold-hbar> | Estrutura de referência (`packages/*`, workspaces, `engines.node`, `AGENTS.md`); branches `templates/*` como exemplos de `template.json` |
| **S4** | Repositório `hedera-dev/create-scaffold-hbar` (CLI, npm `create-scaffold-hbar@0.4.0`), commit `5732f5e` (2026-09-04) | <https://github.com/hedera-dev/create-scaffold-hbar> | Guia de templates de terceiros (`contributors/THIRD-PARTY-TEMPLATES.md`), schema Zod do manifesto (`src/types.ts`), resolução do manifesto (`src/utils/template-capabilities.ts`, `parse-github-template-ref.ts`) |
| **S5** | Repositório `hedera-dev/hedera-harness` (branch padrão `master`) | <https://github.com/hedera-dev/hedera-harness> | Definição de *harness spec* e *validators* (README, `docs/authoring-a-recipe.md`) |
| **S6** | `hedera-dev/hedera-skills` (plugin do harness, citado por S5) | <https://github.com/hedera-dev/hedera-skills> | Apenas referência (`/create-harness-spec`) |

Precedência: em conflito entre fontes, **S1 prevalece como texto do bounty**, mas o conflito **não é resolvido aqui** — é registrado na [seção de divergências](#divergencias).

<a id="revalidacao"></a>

### 1.2 Validação obrigatória antes da submissão final (tarefa #20)

> ⚠️ **As regras do bounty podem ser atualizadas.** Antes da submissão final da tarefa **#20**, **toda** a Parte A, a Parte B, os prazos (seção 2) e a seção de divergências **devem ser revalidados contra S1–S5**, e o [registro de revalidações](#apendice-b) preenchido. Qualquer diferença deve ser refletida neste documento (com atualização do metadado "Última validação") **antes** de prosseguir.

Limitações da validação de 2026-09-18 que a revalidação deve sanar:

1. **S1 foi lida via ferramenta de extração de páginas** (WebFetch), pois o download direto foi bloqueado pelo Cloudflare (HTTP 403 a `curl`). Foram feitas 4 extrações independentes, consistentes em substância; houve pequenas variações de capitalização nos nomes dos critérios (ver D-08). **Um humano deve reler S1 no navegador e conferir cada citação `[OFICIAL]` deste documento.**
2. S1 menciona um **script de self-check** ("run the self-check script before submitting") **sem nome nem link**. Busca na organização `hedera-dev` (GitHub) não encontrou script correspondente em 2026-09-18. Reconfirmar se foi publicado.
3. S1 indica que a URL de registro e o link do **dev-ex survey** não estavam disponíveis ("URL TBC" / sem link). Reconfirmar.

---

<a id="prazos"></a>

## 2. Prazos e estrutura do julgamento

Fonte: **S1** (seção "Key dates", "The eligibility gate", "Prizes and recognition"). Todos os itens **[OFICIAL]**.

| Marco | Data (conforme S1) |
|---|---|
| Registro | Segunda-feira, 14 de setembro |
| Construção e submissões abertas | Segunda-feira, 21 de setembro |
| AMA e office hours | Terça-feira, 29 de setembro, 10:00 AM ET |
| **Submissões encerram** | **Domingo, 4 de outubro, 11:59 PM ET** |
| Julgamento | Segunda-feira, 5 de outubro a sexta-feira, 16 de outubro |
| Vencedores anunciados | Segunda-feira, 19 de outubro |

> Ano não impresso na extração de S1; os dias da semana coincidem com o calendário de **2026** (14/set, 21/set, 29/set, 4/out, 5/out, 16/out e 19/out). **[DERIVADO]**
>
> Conversão de referência **[DERIVADO]** do encerramento: 23:59 ET (EDT, UTC−4) de 04/10/2026 = **03:59 UTC de 05/10/2026 = 00:59 BRT (UTC−3) de 05/10/2026**. Recomenda-se submeter com folga substancial; o fuso oficial é ET.

**Estrutura do julgamento (S1):**

> "Judging runs in two stages. Stage one is a mechanical pass or fail, and every item is required. Nothing reaches the panel until it passes, so run the self-check script before submitting."

> "Prizes go only to submissions that clear the eligibility gate. If three templates pass, three prizes are paid and the rest of the pool stays unallocated."

> "$10,000 in total, split as five equal prizes of $2,000, decided by the panel on the rubric above."

Consequências diretas (todas literais em S1, reorganizadas):

- **Estágio 1** = gate (Parte A): mecânico, pass/fail, **todos** os itens obrigatórios.
- **Estágio 2** = painel, sobre a rubrica (Parte B). Só acessível a quem passou o estágio 1.
- Prêmios: 5 × US$ 2.000 (pool US$ 10.000) para as submissões de maior pontuação **que passaram o gate**; se menos de 5 passarem, o restante fica sem alocação.
- Cada submissão é julgada isoladamente ("Each submission is judged on its own. Focus usually scores better than volume."). Equipes podem participar (registrar como time, informando o tamanho); prêmio é um único prêmio de US$ 2.000 por submissão vencedora.
- Templates que passam no gate são listados na doc da Hedera com crédito ao autor, **independentemente de ganhar prêmio** ("that listing does not depend on winning a prize").
- Propriedade: "It stays yours. The docs listing points at your repository, credited to you, and you continue to maintain it."

---

<a id="parte-a"></a>

## 🔴 Parte A — Gate de elegibilidade (obrigatório, pass/fail)

> **Regra de leitura:** cada linha abaixo é **obrigatória**. Nenhuma gera pontos. Falhar **um** item = submissão fora da disputa. A verificação operacional de cada item está na Parte C (coluna "Ref. gate").

### A.1 Texto oficial da lista do gate (S1, "The eligibility gate")

> - "Scaffolds cleanly via `npm create scaffold-hbar@latest --template owner/repo`"
> - "`template.json` manifest present and valid"
> - "`README.md` and `AGENTS.md` present"
> - "Install, lint and build pass clean from a fresh scaffold"
> - "App boots and core routes return OK"
> - "At least one Hedera service in play, with a verifiable testnet transaction and a mirror node or Hashscan link supplied"
> - "No committed secrets and no committed `.env`"
> - "MIT licence, original work"
> - "Harness spec and validators submitted, if the harness was used"

### A.2 Requisitos de submissão e de estrutura (S1)

Textos de S1 fora da lista literal do gate (a extração não retornou o nome exato da seção; **reconfirmar a seção** na revalidação):

> "Push to a public repo under an MIT licence."
> "A monorepo layout with separate `packages/` for contracts and frontend"
> "The stack is Next.js with Hardhat or Foundry"
> "npm or Yarn workspaces, on Node 20.18.3 or later"
> "Repo link, a Hashscan or mirror node link proving a testnet transaction, the dev-ex survey, and your harness spec and validators if you used the harness."

Complemento (S1, "What you are building"): "One public repository. A working scaffold-hbar template for a real Hedera use case, structured so that any developer can run one command and have it running locally".

> **[DERIVADO] Decisão de escopo do projeto:** os itens de A.2 (repositório público, monorepo, stack, workspaces, Node) são tratados neste projeto como **obrigatórios de elegibilidade**, embora S1 não afirme literalmente que o estágio 1 os verifica um a um (ver D-07). O *dev-ex survey* consta como parte da submissão; S1 não diz se sua ausência elimina no estágio 1 (ver D-06) — tratado como **obrigatório de submissão**.

### A.3 Matriz de requisitos do gate

Coluna **Origem**: `Lista` = consta na lista literal do gate (A.1); `Submissão` = consta em A.2.

| ID | Requisito | Texto/fato oficial **[OFICIAL]** | Origem | Fonte | Ver |
|---|---|---|---|---|---|
| **GATE-01** | Scaffolda pelo comando oficial com `--template owner/repo` | "Scaffolds cleanly via `npm create scaffold-hbar@latest --template owner/repo`". O CLI aceita `owner/repo` ou `owner/repo#branch`, buscado via giget; qualquer repositório GitHub **público** serve. Branch padrão quando omitido: `main`. | Lista | S1; S2; S4 (`parse-github-template-ref.ts`) | D-02, D-03 |
| **GATE-02** | Repositório público | "Push to a public repo under an MIT licence." / "One public repository." | Submissão | S1 | — |
| **GATE-03** | Licença MIT e trabalho original | "MIT licence, original work" / "The code has to be original work under an MIT licence. The use case does not have to be unheard of." | Lista | S1 | — |
| **GATE-04** | Estrutura em monorepo com packages separados | "A monorepo layout with separate `packages/` for contracts and frontend" / "Use a monorepo layout with `packages/` for contracts and frontend" (S2). Estrutura de referência de terceiros: `packages/foundry`, `packages/hardhat`, `packages/nextjs`, `.gitignore`, `README.md` (S4). | Submissão | S1; S2; S4 | — |
| **GATE-05** | Next.js | "The stack is Next.js with Hardhat or Foundry". Valor do manifesto: `frontend: "nextjs-app"`. | Submissão | S1; S4 (`types.ts`) | — |
| **GATE-06** | Hardhat **ou** Foundry | "The stack is Next.js with Hardhat or Foundry". Valores do manifesto: `solidityFramework`: `hardhat` \| `foundry`. | Submissão | S1; S4 | — |
| **GATE-07** | Workspaces (npm ou Yarn) | "npm or Yarn workspaces, on Node 20.18.3 or later". Repositório base usa `workspaces.packages` (`packages/hardhat`, `packages/nextjs`, `packages/foundry`) e `packageManager: yarn@3.2.3`. | Submissão | S1; S3 (`package.json`) | D-04 |
| **GATE-08** | Node **≥ 20.18.3** | "npm or Yarn workspaces, on Node 20.18.3 or later". Corrobora: `engines.node: ">=20.18.3"` no `package.json` de S3. | Submissão | S1; S3 | D-05 |
| **GATE-09** | `template.json` presente **e válido** | "`template.json` manifest present and valid". S4 valida o manifesto com schema Zod (`TemplateManifestSchema`), que exige `name` (string não vazia); `description`, `version` e o bloco `create-scaffold-hbar` são opcionais. O CLI lê `template.json` **da raiz do repositório na ref informada** (padrão `main`) via API do GitHub. | Lista | S1; S4 (`types.ts`, `template-capabilities.ts`) | **D-01** |
| **GATE-10** | `README.md` | "`README.md` and `AGENTS.md` present". S4: "Include clear setup instructions in your repository `README.md`." | Lista | S1; S4 | — |
| **GATE-11** | `AGENTS.md` | "`README.md` and `AGENTS.md` present". | Lista | S1 | — |
| **GATE-12** | Ao menos um serviço Hedera real em uso | "At least one Hedera service in play" | Lista | S1 | D-09 |
| **GATE-13** | Ao menos uma transação **real** e **verificável** na **Hedera Testnet** | "with a verifiable testnet transaction" | Lista | S1 | D-10 |
| **GATE-14** | Evidência via Hashscan e/ou Mirror Node | "a mirror node or Hashscan link supplied" / "a Hashscan or mirror node link proving a testnet transaction" | Lista + Submissão | S1 | — |
| **GATE-15** | Instalação limpa | "Install, lint and build pass clean from a fresh scaffold" | Lista | S1 | — |
| **GATE-16** | Lint limpo | (idem) | Lista | S1 | — |
| **GATE-17** | Build limpo | (idem) | Lista | S1 | — |
| **GATE-18** | Aplicação sobe ("boots") e rotas principais retornam OK | "App boots and core routes return OK" | Lista | S1 | D-11 |
| **GATE-19** | Sem secrets e sem `.env` commitados | "No committed secrets and no committed `.env`" | Lista | S1 | D-12 |
| **GATE-20** | *Harness spec* e *validators* — **condicional** (somente se o Hedera Harness foi usado) | "Harness spec and validators submitted, if the harness was used" / "If you use it, submit your harness spec and validators alongside the repo." / "It is strongly recommended for this bounty and it is not required." | Lista + Submissão | S1; S5 | D-13 |

### A.4 Notas oficiais sobre serviços Hedera e testnet (S1)

- Integração alternativa: "Where testnet is unavailable, a read-only integration or a forked-mainnet integration is acceptable, so a missing testnet deployment is not a reason to abandon a good idea." — **[OFICIAL]**, extraída de S1 em 2 extrações; **reconfirmar redação**. A relação exata entre esta exceção e o item GATE-13 ("verifiable testnet transaction") **não é especificada** (D-10). Este projeto **não depende** dessa exceção: a Hedera Testnet está disponível.
- Serviços Hedera: uma extração de S1 enumerou "HTS, HCS, HSS, or Solidity contract" como serviços que satisfazem o gate. Essa enumeração **apareceu em apenas uma das quatro extrações** → tratar como **não confirmada** até releitura humana (D-09).

### A.5 Sobre o Hedera Harness (S1 e S5)

- **[OFICIAL] S1:** "Hedera Harness gives an AI coding agent the context it needs to write working Hedera code: the service APIs, the patterns, and tiered validation. It is strongly recommended for this bounty and it is not required."
- **[OFICIAL] S5:** o *harness spec* (chamado *recipe*) fica em `.harness/spec.yaml`; os *validators* ficam em `.harness/validators/` (ex.: `static.json`, `yarn.json`, `playwright-smoke.yaml`, e `acceptance-contract.json` opcional para o Tier 3); o PRD em `.harness/prd.md`. Diretórios `.harness/skills/`, `.harness/runtime/` e `.harness/runs/` são gitignored por padrão.
- Camadas de validação (S5): Tier 0–1 (determinístico, padrão), Tier 2 (Playwright, `validators.playwright`), Tier 3 (semântico, `validator.enabled`), Tier 3.5 (on-chain, `chainValidation`, testnet).
- **[NÃO ESPECIFICADO]** por S1: quais arquivos exatos compõem "harness spec and validators" para fins de submissão; o que caracteriza "used" (uso parcial?). Os caminhos acima vêm de S5, não de S1.

---

<a id="parte-b"></a>

## 🟢 Parte B — Rubrica de pontuação (100 pontos)

> **Regra de leitura:** a rubrica **só é aplicada a submissões que passaram o gate** (Parte A). Pontos **não compensam** falha de gate. O gate **não soma pontos**.

Fonte de todas as linhas e citações desta parte: **S1**, seção "How templates are scored" (pontos e critérios) e "Which integrations count" (definição de *load-bearing*). Prêmio: "decided by the panel on the rubric above".

### B.1 Distribuição oficial

| ID | Categoria (nome PT usado no projeto) | Nome em S1 (conforme extraído) | Pontos | Peso |
|---|---|---|---:|---:|
| **RUB-01** | Ecosystem Integration | "Ecosystem integration and value" | **35** | 35% |
| **RUB-02** | Documentation Quality | "Docs quality" | **30** | 30% |
| **RUB-03** | Code Quality | "Code quality" | **20** | 20% |
| **RUB-04** | Hedera Service Depth | "Hedera service depth" | **15** | 15% |
| | **Total** | | **100** | 100% |

**[NÃO ESPECIFICADO]** por S1: qualquer subdivisão de pontos dentro de cada categoria, escala de notas, fórmula de agregação entre jurados, critério de desempate. **Nenhuma subpontuação foi inventada neste documento.**

### B.2 RUB-01 — Ecosystem Integration (35 pts)

**Critério oficial (S1):**

> "The integration is load-bearing. The template is only possible because of it, and a developer gains a capability they could not easily build alone."

**Definição complementar oficial (S1, "Which integrations count"):**

> "An integration scores well when it is load-bearing: the template does something a developer could not easily build alone, and removing the integration would break the point of the template."

**Integrações citadas por S1 como exemplos:** DEXes (SaucerSwap, Lambdaplex, SilkSuite), oracles (Chainlink, Supra, Pyth), bridges (Axelar, LayerZero, CCIP), lending protocols e armazenamento descentralizado.

| Aspecto avaliado **[OFICIAL]** (extraído do texto) | Como se relaciona com o projeto **[DERIVADO]** |
|---|---|
| A integração é *load-bearing*: o template "is only possible because of it" | O projeto declara (README, `docs/integration.md`) que o oracle é obrigatório: "a settlement cannot execute until validated external data produces a normalized attestation". Remover o oracle deve quebrar o propósito do template. |
| O desenvolvedor "gains a capability they could not easily build alone" | A capacidade candidata é liquidação verificável orientada a eventos (oracle → HCS → contrato → HTS → Mirror Node) como fundação reutilizável. |
| "Removing the integration would break the point of the template" | Os papéis de HCS, HTS, Solidity, Mirror Node e oracle são descritos como indispensáveis (README). |

Notas:

- S1 lista **integrações de ecossistema** (DEX, oracle, bridge...) e avalia **serviços nativos** em critério separado (RUB-04). O projeto deve demonstrar cada um **independentemente**; este documento não assume que um substitui o outro (D-14).
- O provedor de oracle **ainda não foi selecionado** (`docs/integration.md`: "Provider implementation and trust model are pending benchmark decision"). Essa decisão impacta diretamente RUB-01.

### B.3 RUB-02 — Documentation Quality (30 pts)

**Critério oficial (S1):**

> "A developer unfamiliar with the repo goes from scaffold to running app to understanding the pattern without help. Clear setup, prerequisites, env vars, architecture, and an `AGENTS.md`."

| Aspecto avaliado **[OFICIAL]** | Como se relaciona com o projeto **[DERIVADO]** |
|---|---|
| Desenvolvedor **sem familiaridade** com o repositório | Documentação não pode presumir contexto do autor. |
| Jornada **scaffold → app rodando → entendimento do padrão**, "without help" | `README.md` com fluxo completo de ponta a ponta; `docs/deployment.md`, `docs/concepts.md`. |
| Setup claro | Comandos de setup reais e testados (hoje apenas "planejados" no README). |
| Pré-requisitos | Versão de Node/gerenciador de pacotes, conta e saldo em Testnet, chaves de API do oracle. |
| Variáveis de ambiente | `.env.example` documentado (nenhum valor secreto). |
| Arquitetura | `docs/architecture.md`, diagrama do README. |
| `AGENTS.md` | Já exigido no gate (GATE-11); **aqui a qualidade** do conteúdo também pontua. |

Nota: `AGENTS.md` e `README.md` têm **dupla natureza** — *presença* é gate (GATE-10/11); *qualidade* é rubrica (RUB-02). Passar no gate não implica pontuação.

### B.4 RUB-03 — Code Quality (20 pts)

**Critério oficial (S1):**

> "Idiomatic, readable, sensibly structured monorepo. Meaningful tests. Errors handled. No dead code or AI slop."

| Aspecto avaliado **[OFICIAL]** | Como se relaciona com o projeto **[DERIVADO]** |
|---|---|
| Código idiomático e legível | Solidity/TypeScript nas convenções de cada ferramenta (Hardhat, Next.js). |
| Monorepo com estrutura sensata | Fronteiras `packages/hardhat`, `packages/nextjs`, `packages/sdk` claras (GATE-04 é a presença; RUB-03 é a qualidade). |
| **Testes significativos** | Testes unitários de contrato, integração e e2e (hoje planejados); testes devem provar comportamento, não só cobrir linhas. |
| Erros tratados | Integrações externas com timeout/validação/fixture determinística (regra de `AGENTS.md`); erros de Mirror Node com consistência eventual. |
| Sem código morto e sem "AI slop" | Remover scaffolding não usado, `.gitkeep` órfãos, comentários genéricos e código gerado sem revisão antes da entrega. |

Nota: lint/build limpos são **gate** (GATE-16/17); "idiomatic/readable" é **julgamento do painel**, não coberto pelo lint.

### B.5 RUB-04 — Hedera Service Depth (15 pts)

**Critério oficial (S1):**

> "Non-trivial use of native Hedera services. Multiple services composed, or one used with real depth, beats a single token transfer."

| Aspecto avaliado **[OFICIAL]** | Como se relaciona com o projeto **[DERIVADO]** |
|---|---|
| Uso **não trivial** de serviços nativos Hedera | Fluxo composto: HCS (atestado) + contrato Solidity (regra) + HTS (crédito) + leitura via Mirror Node. |
| "Multiple services composed, or one used with real depth" | A composição HCS + Solidity + HTS é o argumento central do projeto. |
| Supera "a single token transfer" | Evitar que a demonstração se reduza a uma única transferência HTS; a transação exigida no gate (GATE-13) é o **mínimo**, não o objetivo de profundidade. |

Nota: a transação testnet do gate e a profundidade de serviços da rubrica são **critérios distintos**: uma única transação verificável satisfaz o gate, mas não demonstra profundidade.

### B.6 Relação gate × rubrica (resumo)

| Tema | Gate (🔴 pass/fail) | Rubrica (🟢 pontos) |
|---|---|---|
| `AGENTS.md` / `README.md` | Presentes (GATE-10, 11) | Qualidade da documentação (RUB-02) |
| Lint / build / install | Passam limpos (GATE-15–17) | Legibilidade, idiomatismo, estrutura (RUB-03) |
| Monorepo | Layout com `packages/` separados (GATE-04) | "Sensibly structured monorepo" (RUB-03) |
| Serviço Hedera | Pelo menos 1 com tx testnet verificável (GATE-12–14) | Profundidade e composição (RUB-04) |
| Integração externa | — (não exigida pelo gate) | *Load-bearing* (RUB-01) |
| Testes | — (não exigidos pelo gate) | "Meaningful tests" (RUB-03) |

---

<a id="divergencias"></a>

## Divergências e ambiguidades entre fontes (D-xx)

> Registradas **sem** assumir interpretação. A coluna "Postura do checklist" indica apenas como a Parte C evita depender da ambiguidade (satisfazendo **todas** as leituras plausíveis), sem redefinir a regra.

| ID | Assunto | O que dizem as fontes | Postura do checklist **[DERIVADO]** |
|---|---|---|---|
| **D-01** | **`template.json` — obrigatoriedade e validade** | S1 (gate): "`template.json` manifest present and valid" → **obrigatório e válido**. S2: descreve o manifesto como **opcional** ("optional manifest"). S4 (`types.ts`): o schema Zod exige `name` (string não vazia); sem `name` o parse falha; S4 (`template-capabilities.ts`): manifesto ausente **ou** inválido → o CLI **cai silenciosamente em capacidades permissivas padrão** (nenhum erro). S1 **não define** "valid". | Tratar como obrigatório (S1) e validar contra o schema de S4 (incluindo `name`). |
| **D-02** | **Forma do comando** | S1: `npm create scaffold-hbar@latest --template owner/repo` (sem `--`). S2: `npm create scaffold-hbar@latest -- --template ...` (com `--`). S4: `npx create-scaffold-hbar@latest --template ...`. O README deste repositório usa a forma com `--`. Repasse de flags por `npm create` sem `--` **não foi verificado** aqui. | Testar **todas** as formas citadas; a forma literal de S1 deve funcionar ou a divergência deve ser reportada. |
| **D-03** | **Ref/branch do template** | S4: sem `#branch`, a ref padrão é `main`; `template.json` é lido da ref informada. S1 não menciona ref. | O gate deve passar a partir da `main` do repositório público. |
| **D-04** | **Gerenciadores de pacote** | S1: "npm or Yarn workspaces". S2 (exemplo de manifesto): `packageManager: ["pnpm", "yarn"]`. S4 (schema): enum aceita apenas `yarn`, `npm`, `none`. S4 (README): Yarn é usado automaticamente. | Usar apenas **npm ou Yarn** (conjunto de S1 ∩ S4); não usar `pnpm`. |
| **D-05** | **Versão do Node** | S1: ≥ 20.18.3. S3 (`engines.node`): `>=20.18.3` (consistente). S4 e S5 (`engines`): `>=20` (menos restritivo). | Regra do gate: **≥ 20.18.3**. |
| **D-06** | **Dev-ex survey** | S1 o lista entre os itens de submissão ("the dev-ex survey"), sem link e sem dizer se sua falta elimina no gate. | Tratado como item obrigatório da submissão; obter link (ver 1.2). |
| **D-07** | **Itens da lista do gate × requisitos de estrutura/stack** | A lista literal do gate (A.1) **não** contém repositório público, monorepo, stack Next.js + Hardhat/Foundry, workspaces nem Node; esses constam em A.2. S1 não diz se o estágio 1 os checa individualmente. | Todos tratados como obrigatórios (decisão de escopo). |
| **D-08** | **Nomes dos critérios da rubrica** | Extrações de S1 divergiram só na capitalização/forma ("Ecosystem integration and value" vs. "Ecosystem Integration & Value"; "Docs quality"). O projeto usa os nomes PT/EN da issue. Pontos são consistentes (35/30/20/15). | Conferir nomes no navegador na revalidação. |
| **D-09** | **Quais serviços contam como "Hedera service"** | Apenas 1 de 4 extrações citou "HTS, HCS, HSS, or Solidity contract". S1 não define formalmente. | Usar ao menos um serviço nativo inequívoco (HCS e/ou HTS) e/ou contrato Solidity; confirmar a enumeração. |
| **D-10** | **Teste de transação × exceção "read-only/forked-mainnet"** | S1 exige "a verifiable testnet transaction" **e** aceita, "where testnet is unavailable", integração read-only ou forked-mainnet. A relação entre as duas frases não é explicada. | Projeto **não usa** a exceção: apresentar transação real em Testnet. |
| **D-11** | **"Core routes"** | S1 não define quais são as "rotas principais" nem a forma da checagem ("return OK"); tampouco o comando de start. | Considerar toda rota de página/API do app e a raiz `/`; documentar a lista no README. |
| **D-12** | **Escopo de "no committed secrets / .env"** | S1 não define se vale para o histórico do Git nem se `.env.example` é permitido. O CLI oficial gera `.env.example` (S4: `generate-env-example.ts`). | `.env.example` só com chaves vazias; nenhum `.env*` real; varrer **todo o histórico** (conservador). |
| **D-13** | **Alcance de "harness used"** | S1 não define uso parcial nem lista de arquivos; caminhos vêm de S5. | Se **qualquer** uso do harness ocorreu, submeter `.harness/spec.yaml` e `.harness/validators/`. |
| **D-14** | **Integração de ecossistema × serviço nativo** | S1 lista integrações de terceiros (DEX/oracle/bridge...) sob "Which integrations count" e avalia serviços nativos em RUB-04; não diz se um serviço nativo isolado conta como RUB-01. | Demonstrar ambos separadamente. |
| **D-15** | **Nome da organização em S4** | `THIRD-PARTY-TEMPLATES.md` recomenda "Fork [`buidler-labs/scaffold-hbar`]", enquanto o repositório oficial atual é `hedera-dev/scaffold-hbar` (S3). Esse guia também **não menciona** `template.json` nem `AGENTS.md`. | Seguir S1 para requisitos; S4 apenas como referência técnica. |
| **D-16** | **Script de self-check / link de registro** | S1 manda rodar o "self-check script" sem nomeá-lo/linkar; nenhum encontrado na org `hedera-dev` em 2026-09-18. Registro: "URL TBC". | Reconfirmar (ver 1.2). Sem script oficial, o checklist da Parte C faz o papel de autoverificação. |

---

<a id="parte-c"></a>

## ☑️ Parte C — Checklist final de submissão

> **Derivado** de A + B (**[DERIVADO]**). Não é regra oficial: é o procedimento do projeto para provar que cada regra foi cumprida. Marque `[x]` apenas com **evidência** anexada (saída de comando, URL ou commit). Executar sobre um **clone limpo do repositório público**, na `main`, **em máquina/contêiner sem estado prévio**.

Comandos entre `<>` dependem da implementação e **ainda não existem** no repositório (o README os lista como "planejados"); substituir pelos reais quando forem criados. Os demais são genéricos.

### C.0 Pré-voo (bloqueante para a tarefa #20)

- [ ] **CHK-00a** Revalidar **S1–S5** contra este documento; preencher o [Apêndice B](#apendice-b) e atualizar o metadado "Última validação". _(Seção 1.2)_
- [ ] **CHK-00b** Conferir **no navegador** todas as citações `[OFICIAL]` de S1 (gate, submissão, rubrica, datas). _(D-08)_
- [ ] **CHK-00c** Confirmar o prazo (**04/10, 23:59 ET**) e a data/hora local de envio planejada, com folga.
- [ ] **CHK-00d** Verificar se o **script de self-check** foi publicado; se sim, executá-lo e anexar a saída. _(D-16)_
- [ ] **CHK-00e** Obter o link do **dev-ex survey** e a confirmação de **registro** (individual ou time). _(D-06, D-16)_
- [ ] **CHK-00f** Reavaliar D-01…D-16: alguma divergência foi resolvida ou surgiu uma nova?

### C.1 Gate — verificação item a item

| ✔ | ID | Ref. gate | Verificação | Evidência esperada |
|:-:|---|---|---|---|
| [ ] | **CHK-01** | GATE-02 | `gh repo view <owner>/<repo> --json visibility` → `PUBLIC`; abrir a URL em janela anônima. | URL + saída |
| [ ] | **CHK-02** | GATE-03 | Arquivo `LICENSE` é MIT; `gh repo view --json licenseInfo` → `MIT`; sem código copiado de terceiros com licença incompatível. | Saída + revisão de origem do código |
| [ ] | **CHK-03** | GATE-04 | Existem `packages/hardhat` (ou `foundry`), `packages/nextjs` (e demais) **com conteúdo** — não só `.gitkeep`. | `ls packages/*` |
| [ ] | **CHK-04** | GATE-05 | Aplicação Next.js (App Router, `nextjs-app`) em `packages/nextjs`. | `package.json` do pacote |
| [ ] | **CHK-05** | GATE-06 | Hardhat **ou** Foundry configurado e compilando (`packages/hardhat`). | Saída de compilação |
| [ ] | **CHK-06** | GATE-07 | `package.json` raiz com `workspaces` listando os packages; gerenciador **npm ou Yarn** (não pnpm); `packageManager` coerente. | `package.json` raiz |
| [ ] | **CHK-07** | GATE-08 | `engines.node` = `>=20.18.3` no `package.json` raiz; testar com Node exatamente **20.18.3** (`node -v`). | `node -v` + instalação bem-sucedida |
| [ ] | **CHK-08** | GATE-09 | `template.json` na **raiz da `main`**, JSON válido, com `name` **e** bloco `create-scaffold-hbar` (`capabilities`/`defaults`) coerente com o repo (`nextjs-app`, `hardhat`/`foundry`, `yarn`/`npm`). Validar contra o schema de S4 (`TemplateManifestSchema`) — **não** basta `JSON.parse`. Conferir que a API do GitHub o serve: `gh api repos/<owner>/<repo>/contents/template.json`. | Saída da validação de schema |
| [ ] | **CHK-09** | GATE-01 | Em diretório vazio e com Node 20.18.3: `npm create scaffold-hbar@latest --template <owner>/<repo>` (**forma literal de S1**) **e** `npm create scaffold-hbar@latest -- --template <owner>/<repo>` (forma de S2). Conclui sem erro. Registrar qualquer diferença de comportamento (D-02). | Log completo das duas execuções |
| [ ] | **CHK-10** | GATE-10 | `README.md` na raiz: pré-requisitos, setup, env vars, comandos, rotas, arquitetura, link para evidência Testnet e para este documento. | Revisão |
| [ ] | **CHK-11** | GATE-11 | `AGENTS.md` na raiz, específico ao projeto e verdadeiro em relação aos comandos existentes. | Revisão |
| [ ] | **CHK-12** | GATE-12 | Ao menos um serviço Hedera nativo real integrado no código executado (HCS e/ou HTS e/ou contrato Solidity implantado). Sem mocks no caminho da evidência. | Trecho de código + tx |
| [ ] | **CHK-13** | GATE-13 | Executar o fluxo na **Hedera Testnet** (`HEDERA_NETWORK=testnet`) e obter ≥ 1 transação com status `SUCCESS`. Conta e chaves **efêmeras/de teste**, saldo do faucet da Hedera. | Transaction ID |
| [ ] | **CHK-14** | GATE-14 | Abrir `https://hashscan.io/testnet/transaction/<txId>` **e/ou** `https://testnet.mirrornode.hedera.com/api/v1/transactions/<txId>` (formato `0.0.x-seconds-nanos`): retorna `result: SUCCESS` e é a transação do fluxo do projeto. Repetir a checagem **após** aguardar indexação (consistência eventual). Link presente no README e no formulário. | Links + resposta |
| [ ] | **CHK-15** | GATE-15 | **Clone limpo** (sem `node_modules`, sem `.env`) → instalação com o gerenciador escolhido termina com código 0. `<yarn install>` ou `<npm install>` | Log, código de saída 0 |
| [ ] | **CHK-16** | GATE-16 | Lint de todos os workspaces termina com código 0 e **sem warnings tolerados**. `<lint>` | Log, código 0 |
| [ ] | **CHK-17** | GATE-17 | Build de todos os workspaces (contratos + Next.js) termina com código 0. `<build>` | Log, código 0 |
| [ ] | **CHK-18** | GATE-18 | Após CHK-15–17, **start** da aplicação (`<start>`/`<dev>`) sobe sem erro; requisitar cada rota principal listada no README (incluindo `/` e rotas de API) → **HTTP 200** e conteúdo esperado. Executar também na pipeline de scaffold do CHK-09 (projeto **gerado**, não só o repositório-fonte). | Lista rota → status |
| [ ] | **CHK-19** | GATE-19 | `git ls-files \| grep -E '(^\|/)\.env($\|\.)'` só devolve `.env.example`; varredura de secrets em **todo o histórico** (ex.: `gitleaks detect`); `.env.example` sem valores; `.gitignore` cobre `.env*`. | Saída da varredura |
| [ ] | **CHK-20** | GATE-20 | Se o Harness foi usado em **qualquer** etapa: `.harness/spec.yaml` e `.harness/validators/` commitados, `harness doctor`/`validate` executados; caso contrário, registrar explicitamente "harness não utilizado". | Arquivos ou declaração |

### C.2 Pacote de submissão

- [ ] **CHK-21** Link do **repositório público** (na `main`, no commit final congelado — anotar SHA).
- [ ] **CHK-22** Link **Hashscan e/ou Mirror Node** da transação Testnet (CHK-14).
- [ ] **CHK-23** **Dev-ex survey** preenchido (CHK-00e).
- [ ] **CHK-24** **Harness spec e validators** anexados, se aplicável (CHK-20).
- [ ] **CHK-25** Submissão enviada **antes de 04/10, 23:59 ET**; comprovante arquivado.
- [ ] **CHK-26** Nenhum commit posterior ao SHA submetido altera o comportamento validado (congelar a `main` ou usar tag).

### C.3 Autoavaliação da rubrica (não bloqueante; orienta esforço)

Não gera aprovação/reprovação; serve para priorizar melhorias por peso. Anexar breve justificativa por item.

| ✔ | ID | Ref. rubrica | Pergunta de autoavaliação | Peso |
|:-:|---|---|---|:-:|
| [ ] | **CHK-27** | RUB-01 | Remover a integração externa (oracle) quebra o propósito do template? Um desenvolvedor obtém uma capacidade que "could not easily build alone"? Provedor de oracle escolhido e documentado? | 35 |
| [ ] | **CHK-28** | RUB-02 | Um desenvolvedor desconhecido vai de scaffold → app rodando → entendimento do padrão **sem ajuda**? Setup, pré-requisitos, env vars, arquitetura e `AGENTS.md` claros e testados por alguém de fora? | 30 |
| [ ] | **CHK-29** | RUB-03 | Código idiomático e legível? Monorepo bem estruturado? Testes **significativos** passando? Erros tratados? Sem código morto, `.gitkeep` órfãos ou "AI slop"? | 20 |
| [ ] | **CHK-30** | RUB-04 | Há composição de múltiplos serviços nativos (ex.: HCS + Solidity + HTS) ou uso com profundidade real — além de uma única transferência de token? | 15 |

### C.4 Decisão final (tarefa #20)

- [ ] **CHK-31** Todos os itens `CHK-00a`–`CHK-26` marcados **com evidência**. Um único item do gate em aberto (**CHK-01 a CHK-20**) = **não submeter** sem correção.
- [ ] **CHK-32** Este documento foi revalidado contra as fontes (CHK-00a) e nada mudou — ou as mudanças foram incorporadas e o checklist reexecutado.

---

## Apêndice A — Estado do repositório na data da validação (não normativo)

Snapshot de **2026-09-18** (commit `a87cfba`), apenas para orientar #19/#20. Não faz parte das regras oficiais e **fica desatualizado** conforme o projeto evolui.

| Item do gate | Observação no repositório |
|---|---|
| GATE-03 | `LICENSE` (MIT, © 2026 Filipe Martins) presente. |
| GATE-04 | `packages/hardhat`, `packages/nextjs`, `packages/sdk` existem, mas contêm apenas `.gitkeep`. |
| GATE-07 / 08 | Não há `package.json` raiz (sem `workspaces` nem `engines`). |
| **GATE-09** | `template.json` existe, mas **não possui o campo `name`**, exigido pelo schema de S4 (D-01) — como o CLI cai em padrões permissivos, a falha não seria ruidosa. Declara apenas `yarn` como gerenciador. |
| GATE-10 / 11 | `README.md` e `AGENTS.md` presentes; comandos ainda "planejados". |
| GATE-12 – 14 | Nenhuma transação Testnet registrada ainda. |
| GATE-15 – 18 | Sem scripts de install/lint/build/start; `.github/workflows/` só com `.gitkeep`. |
| GATE-19 | `.env.example` com chaves vazias; não há `.env` versionado. |
| RUB-01 | Provedor de oracle **pendente** (`docs/integration.md`). |

<a id="apendice-b"></a>

## Apêndice B — Registro de revalidações

Preencher a cada revalidação contra as fontes. A linha de **#20** é **obrigatória** antes da submissão final.

| Data | Responsável | Contexto | Fontes reconferidas | Mudanças encontradas | Ação |
|---|---|---|---|---|---|
| 2026-09-18 | Claude Code (via WebFetch/`gh`) | Criação do documento | S1–S5 | — (baseline) | Ver limitações em 1.2 |
| _pendente_ | _____ | **Pré-submissão final — tarefa #20** | S1–S5 | | |

## Apêndice C — Histórico deste documento

| Data | Alteração |
|---|---|
| 2026-09-18 | Criação: prazos, gate (GATE-01–20), rubrica (RUB-01–04), divergências (D-01–16) e checklist (CHK-00–32). |

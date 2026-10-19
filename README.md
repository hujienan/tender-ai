# TenderAI

TenderAI is an applied AI engineering prototype for reviewing construction tenders and supplier proposals. It uses Amazon Bedrock to extract structured facts from PDFs, checks each cited quotation against its source, and applies deterministic rules to supported facts. The project uses **synthetic procurement documents** and supports human review; it does not rank suppliers or make award decisions.

## Implemented capabilities

- Structured extraction with LangChain.js, Bedrock Nova Lite or Nova Pro, Zod schemas, page citations, and one bounded retry with feedback for incomplete responses.
- Full-document assessment and **experimental RAG assessment**. RAG grounds each citation in both the original PDF and passages retrieved for that extraction operation.
- Separate PDF indexing with Titan Text Embeddings V2, followed by semantic search in local PostgreSQL with pgvector.
- Deterministic checks for completion dates and mandatory insurance evidence, with unsupported fields flagged for review.
- Offline revalidation and field-by-field evaluation against synthetic reference answers. Reports retain raw model responses, token usage, latency, recovery provenance, and estimated Nova inference cost.

## Architecture

```mermaid
flowchart LR
  PDF["Synthetic tender and supplier PDFs"] --> TEXT["PDF.js page text"]
  TEXT --> FULL["Full-document path"]
  TEXT --> INDEX["Separate manual indexing"]
  INDEX --> TITAN["Titan V2 embeddings"] --> DB[(PostgreSQL + pgvector)]
  DB --> RAG["RAG retrieval with Titan query embeddings"]
  FULL --> NOVA["Bedrock Nova Lite / Pro"]
  RAG --> NOVA
  NOVA --> EXTRACT["LangChain structured extraction"]
  TEXT --> VALID["Source citation checks"]
  EXTRACT --> VALID
  VALID --> RULES["TypeScript compliance rules"] --> REPORT["Assessment report"]
  REPORT --> EVAL["Offline evaluation"]
  REF["reference.json: offline only"] --> EVAL
```

Indexing is a separate command. Titan embeds document chunks and retrieval queries; pgvector ranks passages; Nova extracts facts. TypeScript verifies source evidence and runs the compliance rules. Reference answers are used only by fixture generation, tests, and offline evaluation, never by inference, indexing, or retrieval. See [architecture details](docs/architecture.md).

| Technology                      | Role                                    |
| ------------------------------- | --------------------------------------- |
| TypeScript / Node.js 24         | Strict runtime and tooling              |
| LangChain.js / AWS Bedrock      | Structured model invocation             |
| Amazon Nova Lite and Pro        | Tender and supplier fact extraction     |
| Amazon Titan Text Embeddings V2 | Document and query embeddings           |
| PostgreSQL / pgvector           | Local chunk storage and semantic search |
| PDF.js (`pdfjs-dist`)           | Page-aware PDF text extraction          |
| Zod                             | Output schemas and validation           |
| Vitest                          | Offline automated tests                 |
| Docker Compose                  | Local PostgreSQL service                |

## Example: synthetic Voltline proposal

The [tender](datasets/electrical-installation/pdfs/tender-request.pdf) requires current public liability insurance evidence. The [Voltline proposal](datasets/electrical-installation/pdfs/voltline-proposal.pdf) says its public liability certificate is not attached. It also gives a practical-completion milestone of 17 May 2027 and a commercial offer completion date of 21 May 2027. TenderAI can flag the missing evidence and conflicting supplier dates when the relevant facts and citations validate. The rule output calls for review rather than an award decision; previous live runs have included other fields that failed validation.

## Getting started

Use Node.js **24 LTS** ([`.nvmrc`](.nvmrc)), pnpm **11.25.0** ([`package.json`](package.json)), and Docker Compose for local indexing and RAG. Tests need neither AWS credentials nor PostgreSQL.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm check
```

If you do not use `nvm`, select Node.js 24 through your preferred version manager. `pnpm check` runs TypeScript, ESLint, Prettier verification, and Vitest.

Start the local database and install its schema:

```sh
docker compose -f infra/compose.yaml up -d
export DATABASE_URL='postgresql://tenderai:tenderai_local@127.0.0.1:54329/tenderai'
pnpm db:init
```

The Compose password and port are local development defaults. To change them, set `POSTGRES_PASSWORD` and `POSTGRES_PORT` for Compose and update `DATABASE_URL` accordingly. AWS credentials come from the AWS SDK default credential provider chain (for example, a configured local profile). Do not place access keys in source files or reports; [`.env.example`](.env.example) contains no credentials.

The following commands **invoke AWS and may incur charges**. `--live` is required for indexing, retrieval, and RAG assessment; full-document assessment invokes Nova without that flag. Index before running retrieval or RAG assessment:

```sh
pnpm index:documents --live tender voltline sparrow arcwell
pnpm retrieve --live --document voltline --query "public liability insurance certificate" --top-k 3
pnpm assess voltline nova-lite
pnpm assess voltline nova-pro
pnpm assess voltline nova-lite --mode rag --live
```

`index:documents` and `retrieve` invoke Titan; `assess` invokes Nova, and RAG assessment also invokes Titan for retrieval queries. Assessment reports are saved under ignored `tmp/extractions/` with unique filenames. The CLI can exit nonzero when validation fails while still saving a report for review.

Recheck a saved report against the original PDFs, then compare it with the synthetic reference answers **offline**:

```sh
pnpm revalidate path/to/saved-report.json
pnpm evaluate path/to/saved-report.json
pnpm --silent evaluate:retrieval path/to/saved-rag-report.json
pnpm --silent evaluate:compliance path/to/voltline-report.json path/to/sparrow-report.json path/to/arcwell-report.json
```

`revalidate` also checks recorded retrieval provenance for RAG reports. `evaluate` scores all eight tender and fifteen supplier values, with value accuracy, evidence status and compliance findings reported separately. `evaluate:retrieval` reconstructs ranked chunks and Nova's three retrieval contexts from a saved RAG report and the committed PDFs. It reports query Recall@1/2, evidence hit rate, operation coverage, and field-level extraction observations. `evaluate:compliance` scores the three supported deterministic finding types per supplier, per type and across all supplied reports. Supply at most one report per supplier per run; a single report produces a partial-coverage score. The evaluation commands accept `-` for stdin. These offline commands need no AWS credentials, Docker, or PostgreSQL. See [evaluation metric definitions](docs/architecture.md#offline-compliance-evaluation).

## Status and limits

**Implemented:** structured extraction and evidence validation; document indexing and semantic retrieval; experimental RAG assessment; deterministic compliance findings; offline extraction, RAG retrieval and compliance evaluation on synthetic fixtures.

**Planned:** repeated experiment comparison, LangSmith tracing, LangGraph workflow orchestration, an API and reviewer interface, and AWS deployment. See the [roadmap](docs/roadmap.md).

The fixtures are synthetic and few in number. PDF.js does not OCR scanned pages. Evidence rules reflect current document patterns and do not authenticate insurance certificates. Retrieval can miss relevant passages, and no RAG accuracy advantage has been demonstrated. Report cost estimates cover Nova attempts, **not Titan embeddings**, and are not billed amounts. There is no production deployment or automated supplier award decision.

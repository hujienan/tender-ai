# TenderAI

TenderAI is a TypeScript prototype for reviewing synthetic construction tenders and supplier proposals with traceable evidence. It extracts facts, validates citations, and produces supported compliance findings and human-review requirements. It does not rank suppliers or make award decisions.

## Architecture

| Package | Responsibility |
| --- | --- |
| `packages/pdf` | Extract page-labelled text from PDFs. |
| `packages/bedrock` | Configure Nova Lite/Pro chat models and estimate supported inference costs. |
| `packages/extraction` | Define fact schemas, invoke structured extraction, validate citations and fields, and recover partial results. |
| `packages/comparison` | Apply deterministic compliance rules to validated facts. |
| `packages/assessment` | Coordinate the three extraction operations and assemble the report. |
| `packages/indexing` | Chunk PDFs, create Titan embeddings and store them in local PostgreSQL with pgvector. |
| `packages/evaluation` | Score saved reports against reference answers offline. |

The canonical entry point is [`runTenderAssessment()`](packages/assessment/src/run.ts). Assessment and indexing are separate: the current assessment reads full PDF text and does not query PostgreSQL. See the [architecture](docs/architecture.md) for the dependency graph and data contracts.

## Development

Use Node.js 24 LTS (see `.nvmrc`) and pnpm 11.25.0:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs strict TypeScript, ESLint, Prettier verification and Vitest. Automated tests mock model calls and need neither AWS credentials nor Docker. The synthetic PDFs are in `datasets/electrical-installation/pdfs/`. `pnpm fixtures:generate` regenerates them from `reference.json` only when fixture content is deliberately changed.

## Assessment: manual, billable

```sh
pnpm assess voltline nova-lite
pnpm assess voltline nova-pro
```

The supported suppliers are `voltline`, `sparrow` and `arcwell`; the models are `nova-lite` and `nova-pro`. The defaults are Voltline and Nova Lite. AWS credentials come from the SDK default provider chain; none are stored in this repository. The CLI uses the synthetic tender and selected supplier PDF, then makes three independent structured calls: tender general requirements, tender compliance requirements and supplier facts. Each failed operation may retry once. Zod, page citations and field-level checks gate deterministic findings. The CLI saves a uniquely named report under `tmp/extractions/` and exits nonzero if tender or supplier validation fails.

New reports use **`schemaVersion: 1`**. They retain source citations, raw responses, attempt and recovery provenance, model IDs, region, token usage, latency, findings and estimated cost. Cost estimates are not billed amounts; unsupported rates or missing usage produce a null complete total. [Rate details and limitations](docs/architecture.md#model-and-cost-boundaries) are documented separately.

Use the path printed by `assess` for offline checks:

```sh
pnpm revalidate <saved-report>
pnpm evaluate <saved-report>
```

`revalidate` rereads the PDFs and recomputes field validity and deterministic findings without a model call. `evaluate` scores a saved current report against `datasets/electrical-installation/reference.json`. Reference answers are reserved for fixture generation, tests and offline evaluation. Assessment, indexing and future retrieval must never load them or receive them in prompts.

## Document indexing: manual, billable

```sh
docker compose -f infra/compose.yaml up -d
export DATABASE_URL='postgresql://tenderai:tenderai_local@127.0.0.1:54329/tenderai'
pnpm db:init
pnpm index:documents --live tender voltline sparrow arcwell
```

Compose binds PostgreSQL to `127.0.0.1:54329`; its default password is for local development. The `--live` command may incur Bedrock charges. Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) runs in `ap-southeast-2` with 1,024-dimensional vectors. Page-aware chunks retain exact PDF.js text slices, source offsets and hashes. Unchanged documents skip embedding and database writes.

A previous local smoke test inserted a `tender` row with **mock** embeddings (`mock:offline-smoke`). The current indexer checks embedding model metadata and will replace that row on a live Titan run, but the local database may contain mock vectors until then. Treat this as a separate indexing reliability cleanup before using retrieval; this task does not alter database contents. Concurrent changed-document runs can also duplicate billable embedding calls.

## Current limits

PDF.js does not OCR scans. Source checks use patterns matched to the synthetic documents and do not authenticate insurance certificates. Warranty scope and qualification validity remain human-review topics. Semantic retrieval, retrieval-grounded extraction, LangGraph, LangSmith, an API, a frontend and AWS deployment are not implemented. See the [roadmap](docs/roadmap.md).

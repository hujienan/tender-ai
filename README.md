# TenderAI

TenderAI is a planned procurement evaluation platform. Tender reviewers need to compare proposals against published criteria while tracing every claim to its source page and flagging gaps for human clarification. This repository contains the **Milestone 1 synthetic dataset** and **Milestone 2 Bedrock extraction tools**. It does not score real suppliers or make award decisions.

## Layout and architecture

| Path                                | Purpose                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/`                             | Future API and reviewer application workspaces; empty in Part A.                        |
| `packages/bedrock/`                 | LangChain.js Bedrock client and direct Nova Lite pricing.                               |
| `packages/pdf/`                     | Page-preserving text extraction with PDF.js.                                            |
| `packages/extraction/`              | Independent tender and supplier extraction, schemas and citation validation.            |
| `packages/comparison/`              | Deterministic compliance findings and workflow assembly.                                |
| `packages/evaluation/`              | Offline reference scoring; never imported by inference.                                 |
| `datasets/electrical-installation/` | Canonical synthetic text, expected facts, issue annotations and generated PDF fixtures. |
| `tests/`                            | Vitest checks for dataset consistency, extraction and mocked Bedrock calls.             |
| `scripts/`                          | Fixture generation, manual Bedrock commands and offline evaluation.                     |
| `infra/`                            | Reserved for later infrastructure code; empty in Part A.                                |
| `docs/`                             | [Architecture](docs/architecture.md) and [roadmap](docs/roadmap.md).                    |

The root is a private pnpm workspace. Node.js 24 LTS is pinned in `.nvmrc` and `package.json`; TypeScript strict mode covers the Bedrock module, generator and tests. The PDF files are generated from the document text in `reference.json`. Each expected answer and issue includes a document ID, one-based page number and verbatim evidence quote. Tests extract text from the PDFs to verify those locations.

The Bedrock module uses `@langchain/aws` and `ChatBedrockConverse` with Amazon Nova Lite in `ap-southeast-2`. Milestone 2C extracts tender requirements and supplier facts in **separate calls**. Each call sees only its own page-labelled PDF text. Zod and citation checks validate the results before a deterministic comparison produces supported compliance findings and review reasons. The report keeps both raw model responses, token usage, latency, validation errors and estimated costs. A separate offline process scores saved reports against reference answers. The historical Milestone 2B extractor and archived outputs remain for comparison; see [architecture](docs/architecture.md).

## Dataset

The fictional North Quay Training Centre requests low-voltage distribution, lighting, emergency lighting and cabling work. Five weighted criteria cover price, methodology and safety, programme, capability, and warranty and risk. Three fictional suppliers differ in price, duration, warranty and qualifications. Deliberate evaluation traps include a missing public liability certificate, conflicting completion dates, vague warranty exclusions, late completion and an expired supervisor licence. All names, addresses, licence identifiers and projects are synthetic.

`reference.json` is reserved for fixture generation, tests and offline evaluation. AI inference uses only the PDFs or extracted source documents; it must never read the reference answers or receive them in prompts, retrieval indexes or runtime payloads. Evaluation code compares saved model outputs with those answers only after inference is complete.

## Development

Install Node.js 24 LTS and pnpm 11.25.0, then verify both versions before installing dependencies:

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm fixtures:generate
pnpm check
```

`pnpm check` runs type checking, ESLint, Prettier verification and Vitest. `pnpm format` applies formatting to TypeScript and tool configuration files. Run `pnpm fixtures:generate` after editing document pages in `datasets/electrical-installation/reference.json`; commit the regenerated PDFs with the JSON. The generator has no network or cloud side effects.

## Bedrock demo (manual, billable)

The demo fixes the model to `amazon.nova-lite-v1:0` and the region to `ap-southeast-2`. It leaves credentials unset in code, so the AWS SDK uses its default credential provider chain. With the already configured default AWS profile, no extra environment variables are needed. AWS environment credentials take precedence if present; avoid setting access keys in this repository or its `.env` files. [`.env.example`](.env.example) shows the optional profile override. The demo does not load `.env` files.

```sh
# Use the configured default profile:
pnpm bedrock:demo "Reply with one short greeting."

# Optional: select a different profile for one invocation:
AWS_PROFILE=your-profile pnpm bedrock:demo "Reply with one short greeting."
```

Each manual invocation calls Bedrock and may incur charges. The CLI prints the response followed by the model ID, elapsed invocation time in milliseconds, token usage when returned, and available response metadata. It reports authentication, permission, throttling and other invocation errors in plain language. `pnpm check` uses mocked invocations and never calls AWS.

## Structured extraction and offline evaluation

The following manual command makes **two billable Bedrock calls**, one for the tender and one for the selected supplier (Voltline by default). It prints both extraction reports, the comparison, citations, validation errors, usage, latency and estimated costs. It saves the result to `tmp/extractions/voltline-2c.json`; the 2B baseline files are untouched.

```sh
pnpm extract:supplier
```

Revalidate the saved facts and citations against the PDFs **offline**, without an AWS call. This prints a revised report without changing the saved model output:

```sh
pnpm revalidate:assessment tmp/extractions/voltline-2c.json
```

To compare the saved 2C report with reference answers, run:

```sh
pnpm evaluate:extraction tmp/extractions/voltline-2c.json
```

Use `pnpm extract:supplier sparrow` or `pnpm extract:supplier arcwell` for the other synthetic suppliers, then pass the matching `-2c.json` file to the offline commands. `pnpm evaluate:extraction datasets/electrical-installation/baselines/2b/voltline-baseline.json` still scores an archived 2B result. Only offline evaluation imports `reference.json`.

The 2C offline report separates supplier factual accuracy, deterministic compliance findings and tender/supplier citation validity. A supervisor qualification may include a trailing parenthesised year without losing a match; the report keeps the original extracted text. The `comparableReferencesCount` check verifies only the number of references, **not project names**. Complex qualitative claims still need human review; a matching quote alone does not establish their truth.

The extractor uses PDF.js text extraction and records one-based page numbers. It does not OCR scanned images. Missing facts remain JSON null, and commercial and programme completion dates remain separate. Every non-null fact needs a source quotation on an existing page; validation permits whitespace differences only. A stated insurance policy ID must appear as a labelled policy or certificate number in its citation; a cover amount is not an ID. An explicitly missing mandatory certificate becomes a deterministic finding only after both source documents validate. Warranty ambiguity and qualification validity remain review candidates. A validation failure still saves available response and cost information. No automatic retries are made; a missing cost estimate leaves the total unavailable.

Cost estimates use the [AWS public Bedrock Price List for Sydney](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-southeast-2/index.json), checked **17 October 2026** (list published 16 October 2026). Direct Standard/default rates per million tokens are **USD $0.063 input / $0.252 output** for `amazon.nova-lite-v1:0` and **$0.84 input / $3.36 output** for `amazon.nova-pro-v1:0`. Estimates use returned token counts and are **not exact billed amounts**. Cross-region inference profiles, other regions or tiers, and cached tokens remain unsupported rather than being priced with the wrong rate. If usage is absent, the cost is unavailable.

No retrieval, workflow engine, database, frontend or AWS infrastructure is part of this milestone.

See [docs/architecture.md](docs/architecture.md) for data contracts and [docs/roadmap.md](docs/roadmap.md) for upcoming milestones.


## Milestone 2D model comparison

Milestone 2D is a parallel extraction path, leaving the existing 2C CLI and saved results unchanged. It uses **three** Bedrock calls with the selected model: one for five general tender facts, one for three compliance tender facts, and one for supplier facts. The two tender results are assembled without inventing failed-group values.

Each field is marked valid, invalid or missing with errors; the comparison engine uses only validated dependencies. For instance, an unsupported public-liability policy ID does not prevent a supported finding that the public-liability certificate is explicitly missing. Review remains required for unresolved fields and subjective matters. Original responses, costs and citations are preserved.

Run each model manually against the same tender and supplier PDFs. Both commands make three billable Bedrock calls; neither runs during tests:

    pnpm extract:2d voltline nova-lite
    pnpm extract:2d voltline nova-pro

Each run prints its saved path, such as `tmp/extractions/voltline-2d-nova-pro-<timestamp>-<id>.json`. Files are created exclusively, so existing 2B, 2C and 2D results are not overwritten. `pnpm extract:2d voltline` still selects Nova Lite. The earlier Nova Lite run at `tmp/extractions/voltline-2d.json` remains available.

For **each** saved path, run the offline commands:

    pnpm revalidate:2d <saved-path>
    pnpm evaluate:extraction <saved-path>

Compare field validation, citation errors, supported findings and offline factual accuracy first. Then compare the three per-call model IDs, regions, input/output token counts, latency and estimated USD cost in `tender.attempts` and `supplier.attempts`, plus `totalEstimatedCostUsd`. Keep supplier and PDFs identical; reference answers are read only by the offline evaluator, never during inference. These are single-run observations, so they do not establish repeatability or exact billing. See [docs/architecture.md](docs/architecture.md) for 2D boundaries. No RAG, database or retry logic is included.

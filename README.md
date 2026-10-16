# TenderAI

TenderAI is a planned procurement evaluation platform. Tender reviewers need to compare proposals against published criteria while tracing every claim to its source page and flagging gaps for human clarification. This repository currently contains **Milestone 1, Part A only**: a TypeScript workspace and a fully fictional electrical installation tender dataset. It does not score real suppliers or make award decisions.

## Layout and architecture

| Path | Purpose |
| --- | --- |
| `apps/` | Future API and reviewer application workspaces; empty in Part A. |
| `packages/` | Future shared TypeScript packages; empty in Part A. |
| `datasets/electrical-installation/` | Canonical synthetic text, expected facts, issue annotations and generated PDF fixtures. |
| `tests/` | Vitest checks for fixture structure, expected answers and PDF page citations. |
| `scripts/` | Local PDF fixture generation from the reference dataset. |
| `infra/` | Reserved for later infrastructure code; empty in Part A. |
| `docs/` | [Milestone roadmap](docs/roadmap.md). |

The root is a private pnpm workspace, ready for apps and packages when they exist. Node.js 24 LTS is pinned in `.nvmrc` and `package.json`; TypeScript strict mode covers the generator and tests. The PDF files are generated from the document text in `reference.json`. Each expected answer and issue includes a document ID, one-based page number and verbatim evidence quote. Tests extract text from the PDFs to verify those locations.

The planned sequence is Bedrock structured extraction, RAG, a LangGraph evaluation workflow, LangSmith evaluations, reliability work and AWS deployment. An API and reviewer frontend come later. None of those services or runtime dependencies are present yet.

## Dataset

The fictional North Quay Training Centre requests low-voltage distribution, lighting, emergency lighting and cabling work. Five weighted criteria cover price, methodology and safety, programme, capability, and warranty and risk. Three fictional suppliers differ in price, duration, warranty and qualifications. Deliberate evaluation traps include a missing public liability certificate, conflicting completion dates, vague warranty exclusions, late completion and an expired supervisor licence. All names, addresses, licence identifiers and projects are synthetic.

`reference.json` is reserved for fixture generation, tests and offline evaluation. Future AI inference must use only the PDFs or extracted source documents; it must never read the reference answers or receive them in prompts, retrieval indexes or runtime payloads. Evaluation code may compare model outputs with those answers only after inference is complete.

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

See [docs/roadmap.md](docs/roadmap.md) for upcoming milestones.

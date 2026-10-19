# Roadmap

TenderAI is an applied AI engineering prototype built on synthetic procurement documents. The current CLI supports assessment and review; future milestones are planned work.

## Implemented

- **Project foundation:** Node.js 24, pnpm workspaces, strict TypeScript, synthetic PDFs, reference answers, and offline tests.
- **Structured assessment:** Nova Lite/Pro extraction through LangChain.js, Zod output validation, page citations, evidence checks, one bounded structural retry with feedback, and recovery provenance.
- **Deterministic comparison:** Field-gated completion-date and insurance-evidence findings, plus human-review reasons.
- **Document indexing:** Page-aware chunks, Titan Text Embeddings V2, and idempotent local PostgreSQL/pgvector storage.
- **Semantic retrieval:** Document-scoped cosine search with original passage provenance.
- **Experimental RAG assessment:** Separate tender-general, tender-compliance, and supplier retrieval contexts; citations checked against both retrieved passages and original PDFs.
- **Offline extraction evaluation (Milestone 3D-A):** Saved-report revalidation, complete tender and supplier field scoring, explicit null handling, separate evidence status, and expected finding comparison. The reference set remains small.
- **Offline RAG retrieval evaluation (Milestone 3D-B):** Source-checked retrieval annotations, query Recall@1/2, evidence hit rate, operation-level context coverage and extraction-stage observations from saved reports.
- **Offline compliance evaluation (Milestone 3D-C):** Per-supplier and per-type confusion counts and micro precision, recall and F1 for the three supported deterministic findings. Qualitative issues, review topics and evidence validity remain separate.
- **Offline repeated experiment evaluation (Milestone 3D-D):** Saved-run manifests, model/mode grouping, extraction, retrieval and compliance reuse, operational metrics, descriptive variation and explicit pairing.

## Upcoming milestones

### Milestone 4 — LangSmith

Add execution tracing, debugging for model and retrieval failures, and evaluation experiment tracking.

### Milestone 5 — LangGraph

Build a stateful assessment workflow with conditional retrieval, targeted recovery, and human-in-the-loop handling where useful.

### Milestone 6 — Application MVP

Add an API, document upload, assessment execution, evidence-backed results, and a reviewer interface.

### Milestone 7 — Deployment

Deploy on AWS with infrastructure as code where appropriate, monitoring, and cost controls.

### Milestone 8 — Portfolio finalisation

Prepare architecture documentation, evaluation results, a demonstration, and clear known limitations.

Reference answers remain reserved for fixture generation, tests, and offline evaluation. Inference, indexing, and retrieval must never read them or receive them in prompts or vector storage. See [architecture details](architecture.md) and [developer commands](../README.md).

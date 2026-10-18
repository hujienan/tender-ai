# Roadmap

1. **Synthetic data and project setup — complete.** Strict TypeScript workspace, fictional tender and supplier PDFs, reference answers and offline tests.
2. **Structured assessment — implemented.** Bedrock Nova Lite/Pro extraction, separate tender and supplier operations, cited facts, field validation, bounded recovery, deterministic findings, provenance and cost estimates. The current report contract is `schemaVersion: 1`; live quality remains under evaluation.
3. **Local document indexing — implemented.** Deterministic PDF chunks, Titan V2 embeddings and idempotent PostgreSQL + pgvector storage. The index remains separate from assessment.
4. **Semantic retrieval — planned for Milestone 3B.** Query relevant passages from the local vector store, with document isolation and provenance. Resolve the documented mock-vector contamination risk before relying on retrieval.
5. **Retrieval-grounded extraction — planned.** Supply retrieved source passages to extraction while retaining current validation and comparison safeguards.
6. **Workflow and evaluation — planned.** LangGraph coordination and LangSmith tracing/evaluations, with reference answers restricted to offline scoring.
7. **Application and deployment — planned.** Reliability work, an API, a reviewer interface and tested AWS deployment.

Reference answers are test and evaluation data only. AI inference and indexing must never read them or receive them in prompts or vector storage. See the [current architecture](architecture.md) and [developer commands](../README.md).

# Planned milestones

1. **Part A (complete):** strict TypeScript workspace, synthetic PDFs, cited reference facts and fixture tests.
2. **Bedrock (2A and 2B, complete):** connect LangChain.js to Amazon Nova Lite, extract structured facts from PDFs with page citations, and estimate inference cost.
3. **Extraction architecture (2C, complete):** independently extract tender requirements and supplier facts, validate each source, compare deterministic compliance rules, archive the 2B baselines and score results offline. See [architecture](architecture.md).
4. **Extraction reliability (2D, implemented locally; live inference unverified):** split tender requirements into two targeted model calls, validate each fact separately, and derive compliance findings only from their verified dependencies. The 2C pipeline remains available as a baseline.
5. **RAG:** introduce PostgreSQL and pgvector for source storage and retrieval, then ground criterion-level analysis in relevant passages.
6. **LangGraph:** coordinate the evaluation and human review workflow using the extracted and retrieved evidence.
7. **LangSmith evaluations:** measure extraction and evaluation quality against the reference answers in a separate test/evaluation process.
8. **Reliability:** extend validation, failure handling, security and operational checks before production use.
9. **Deployment:** build the API and reviewer interface, then deploy the tested system on AWS.

The reference answers are test and evaluation data only. AI inference must never read them or receive them in prompts, retrieval indexes or runtime payloads. RAG and later stages are planned, not implemented or delivery commitments. No cloud resources are created by Milestones 1 or 2.

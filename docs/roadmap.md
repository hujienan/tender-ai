# Planned milestones

1. **Part A (complete):** strict TypeScript workspace, synthetic PDFs, cited reference facts and fixture tests.
2. **Bedrock structured extraction:** ingest tender and proposal PDFs, extract typed facts with page-level provenance, and store reviewable results in PostgreSQL.
3. **RAG:** retrieve relevant source passages for each criterion and ground AI-generated claims in those passages.
4. **LangGraph:** coordinate the evaluation and human review workflow using the extracted and retrieved evidence.
5. **LangSmith evaluations:** measure extraction and evaluation quality against the reference answers in a separate test/evaluation process.
6. **Reliability:** add validation, failure handling, security and operational checks before production use.
7. **Deployment:** build the API and reviewer interface, then deploy the tested system on AWS.

The reference answers are test and evaluation data only. AI inference must never read them or receive them in prompts, retrieval indexes or runtime payloads. These stages are planned, not implemented or delivery commitments. No cloud resources are created by Part A.

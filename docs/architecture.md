# TenderAI architecture

## Module dependencies

```mermaid
flowchart LR
  PDF[packages/pdf] --> EXT[packages/extraction]
  BED[packages/bedrock] --> EXT
  EXT --> ASM[packages/assessment]
  CMP[packages/comparison] --> ASM
  PDF --> IDX[packages/indexing]
  BED --> IDX
  IDX --> PG[(Local PostgreSQL + pgvector)]
  PG --> RET[packages/retrieval]
  RET --> ASM
  REPORT[Saved report] --> EVAL[packages/evaluation: offline]
  REF[reference.json: offline only] --> EVAL
```

`packages/assessment/src/run.ts` exports `runTenderAssessment()`, the only end-to-end assessment entry point. Full-document mode remains the default. Experimental RAG mode prepares role-scoped passages with retrieval before invoking the same extraction functions. Extraction returns validated facts; comparison consumes them without invoking Bedrock or PostgreSQL. The PDF package knows nothing about AI or storage. Indexing remains separate from assessment. Evaluation receives saved reports and reference data only through the offline CLI.

## Assessment flow

```mermaid
flowchart LR
  T[Tender PDF] --> P[PDF.js page text]
  S[Supplier PDF] --> P
  P -->|RAG mode only| X[Freshness check and role-scoped retrieval]
  X --> G
  X --> C
  X --> F
  P --> G[Tender general extraction]
  P --> C[Tender compliance extraction]
  P --> F[Supplier fact extraction]
  G --> R[Bounded recovery and field validation]
  C --> R
  F --> R
  R --> V[Citation and value checks]
  V --> D[Dependency-aware comparison]
  D --> O[Schema version 1 report]
```

The orchestrator runs general requirements, compliance requirements and supplier facts in that order. Each operation receives only its own document. Full mode uses complete PDF text. RAG mode checks both indexed documents before any model call, then runs two general, two compliance and three supplier queries with topK 2 per query. Tender queries search only tender chunks; supplier queries search only the selected supplier. Returned chunks are checked against exact PDF slices, deduplicated within each operation and labelled with document ID, page and chunk index. Nova Lite or Nova Pro is selected for all three extraction calls in `ap-southeast-2`. A failed invocation or structurally incomplete response permits one additional attempt. When the first response is available, the retry includes its structural validation errors and requests a complete object; a complete response with unsupported evidence does not automatically retry. Recovered candidates need valid structure and their own supporting citations; conflicting supported values remain unresolved. Insurance certificate status and policy ID are checked separately.

`compareValidatedCompliance()` produces only `late_completion`, `conflicting_dates` and `missing_evidence` when their specific tender and supplier inputs validate. Other invalid fields do not suppress supported findings. Unsupported dependencies require review. Warranty terms and qualification validity are review candidates, not automatic findings.

### Data contracts

- `ExtractedPdf` has a stable document ID and one-based `{ page, text }` entries.
- `TenderRequirements` and `SupplierFacts` use nullable missing facts and `{ value, evidence: [{ documentId, page, quote }] }` citations. General and compliance tender groups remain separate in the report.
- Each model attempt records model ID, region, service tier, latency, token usage, response metadata, raw response, error and estimated cost where available. Recovery records original attempt and tool-call provenance, unresolved fields and field errors. `knownEstimatedCostUsd` sums priced attempts; `totalEstimatedCostUsd` is null if any attempt cannot be priced.
- Current saved reports use **`schemaVersion: 1`**. The `assess`, `revalidate` and `evaluate` commands share that version. There is no parser for obsolete report formats. Existing local `tmp/extractions/` files are left untouched; older formats must be regenerated for the current offline tools.
- New reports identify `mode`; RAG reports also include query and chunk provenance, distinct chunk counts and Titan request count. The CLI records end-to-end latency. Older version 1 reports without `mode` remain accepted by the offline tools.

### Evidence and reference isolation

Citations must point to the correct document and page, and quotations must occur in the original full PDF.js extracted text with only reasonable whitespace normalization. In RAG mode, each citation must also occur in a retrieved passage supplied to its own general, compliance or supplier extraction operation. Recovery applies the same check before selecting candidate values; offline revalidation reconstructs the passages from recorded chunk references and original PDFs. The complete PDF remains the source of truth. Deterministic checks additionally verify straightforward values such as dates, price, duration, warranty months, insurance status and labelled policy IDs. A quote alone does not establish every qualitative claim or certificate authenticity. Unsupported facts remain invalid; the pipeline does not rewrite model output to make it pass.

Only fixture generation, tests and offline evaluation read `datasets/electrical-installation/reference.json`. Runtime assessment, indexing and retrieval never import it, and reference answers must not enter prompts, vector indexes, query embeddings or inference-time rules.

### Offline extraction evaluation

`expectedExtraction` in the synthetic reference dataset gives explicit values, including nulls, for all eight tender and fifteen supplier scoring leaves. The evaluator walks the extraction Zod schemas, checks reference completeness and types, and compares the final saved values. The older cited `answers` and `issues` remain for fixture tests and finding expectations. Saved `schemaVersion: 1` reports work in full and RAG modes; evaluation never invokes Bedrock or PostgreSQL.

Dates compare as ISO values, numbers and booleans exactly. Strings are trimmed, whitespace-collapsed and compared without case; punctuation remains significant. A trailing parenthesised year may be omitted for `supervisorQualification`, but two explicit years must agree. Nullable insurance objects retain separate status and policy ID checks even when the expected object is null. Comparable project names, including their years, compare as an order-independent multiset, so duplicate or wrong names fail even when the count matches. The Sparrow warranty condition reference uses the stated page-one phrase; its separate, unfinished warranty schedule remains an unscored qualitative issue. Paraphrases of conditions may fail this conservative string comparison.

Tender, supplier and combined accuracy show passed and total fields plus failed comparisons. Each field retains its actual value, reference value and saved evidence status. Recovery field errors and unavailable extraction groups prevent placeholder nulls from counting as correct absences; where older reports lack recovery provenance, the result states that limitation. `overallResult` describes evaluation quality, while `procurementReviewStatus` preserves the independent assessment status. A correct missing-evidence finding can therefore coexist with `requires_review` procurement status and an acceptable evaluation result. Offline evaluation reads saved evidence flags; run `revalidate` first when those flags need recomputation against the PDFs and recorded RAG passages.

### Offline RAG retrieval evaluation

`datasets/electrical-installation/retrieval-reference.json` is an offline-only companion to `reference.json`. It locks the current PDF text hashes and chunker version, assigns every extraction leaf to one of the seven queries, and records source-page quotations. Evidence alternatives are OR choices; each quotation in one alternative is required. `explicit_absence` means a passage states that evidence is missing, such as Voltline's unattached public liability certificate. `not_stated` means the full source does not state a value, such as Voltline's public liability policy ID; it is not treated as a retrieval miss. The annotation set is intended to enumerate all direct supporting passages in these synthetic PDFs.

`pnpm --silent evaluate:retrieval <saved-rag-report|->` is offline. It extracts the committed PDFs with PDF.js, verifies their text hashes against the annotations, recreates chunks with the existing chunker, and checks saved document IDs, one-based pages, chunk indexes and any recorded chunk hash. The report stores query results in ranked array order, so positions 1 and 2 are available; it does not store original text. The evaluator reconstructs that text from verified PDF slices. It rejects unknown queries, missing metadata, wrong documents, stale source hashes and incompatible chunk references. Existing reports lack database-side content hashes, embedding metadata and full rankings beyond the returned top two, so offline evaluation cannot independently audit the historical database state or score K greater than 2.

For each query, **Recall@K** is the number of distinct annotated relevant source chunks present in its first K ranked results divided by the complete set of relevant chunks for that query's assigned fields. A chunk is relevant when it contains any part of an annotated direct supporting quotation. Both K=1 and K=2 use the saved ordering. Duplicate results use separate rank slots but count only once as hits. Query **evidence hit rate** is the number of assigned evidence-bearing fields with a complete supporting alternative in that query's returned chunks divided by its evidence-bearing assigned fields. A quotation spanning chunks requires all of those chunks. Fields marked `not_stated` are reported as source absent and excluded from these denominators.

Operation **evidence coverage** uses the deduplicated union of chunks from all queries in the same extraction group. Its denominator is the group's evidence-bearing fields, not the number of chunks or queries. It reports general, compliance and supplier groups separately. Zero hits with a nonzero denominator is zero coverage; no evidence-bearing fields yields a null ratio. Field diagnostics show reference value, extracted value, evidence availability and saved evidence status separately. Missing evidence and a wrong value are observations, not proof that retrieval caused the wrong value. The 3D-A extraction accuracy remains a separate metric.

The fixture has two tender chunks and three chunks per supplier, each currently one PDF page. In the saved first Voltline RAG run, operation coverage is general **5/5**, compliance **3/3**, supplier **14/14**, with one supplier field marked source absent (public liability policy ID). Overall evidence coverage is **22/22**, while extraction accuracy remains **22/23**. The supplier programme/warranty query retrieved page 1 and page 3, giving relevant-chunk Recall@2 of **1/2**; the supplier qualification/insurance query supplied page 2 to the combined context. All evidence-bearing supplier fields therefore reached Nova. The incorrect public liability policy ID was an unsupported extracted value, not a missing annotated passage. These tiny documents often fit almost entirely in context, so high retrieval scores do not establish ranking quality or performance on larger tenders.

### Offline compliance evaluation

`pnpm --silent evaluate:compliance <saved-report...|->` reads `schemaVersion: 1` full-document or RAG reports and the synthetic reference issues. One supplier ID and one supported finding type form a binary evaluation unit. For each of `late_completion`, `missing_evidence` and `conflicting_dates`, an expected and produced finding is a true positive; produced but unexpected is a false positive; expected but absent is a false negative; both absent is a true negative. Per-supplier and per-type counts are summed for micro precision `TP/(TP+FP)`, recall `TP/(TP+FN)`, and F1 `2PR/(P+R)`. A zero denominator yields JSON `null`, including F1 when either input is undefined. Each run accepts at most one report per supplier and reports whether all three reference suppliers are covered.

Repeated findings of one type count once and are separately flagged as duplicate predictions. Unsupported actual finding types are flagged as invalid predictions and excluded from the three-type confusion matrix; they are never silently treated as supported detections. Reference `ambiguous_warranty` and `expired_qualification` issues are listed as unscored. Generic warranty and qualification review candidates, assessment status and extraction accuracy are reported separately from deterministic finding metrics. A correct finding type does not establish correct explanation or citations: the output carries saved tender and supplier validation flags when available and states that finding evidence was not independently checked. Run `revalidate` first to refresh those flags from original PDFs and, for RAG, recorded passages.

The three-supplier committed compliance fixtures are deliberately minimal simulated reports for regression tests, not saved model assessments. Historical full and RAG Voltline reports can be evaluated individually, but together are duplicate reports for one supplier. This synthetic dataset is extremely small and covers only three deterministic issue types. One run, especially a single-supplier run, cannot establish production precision or recall; stronger conclusions need more positive and negative examples across independent tenders.

### Model and cost boundaries

The [AWS public Bedrock Sydney price list](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/ap-southeast-2/index.json) was checked on 17 October 2026. Direct Standard/default rates per million tokens are USD $0.063 input / $0.252 output for `amazon.nova-lite-v1:0` and $0.84 input / $3.36 output for `amazon.nova-pro-v1:0`. Estimates use returned token counts and are not exact AWS bills. RAG's Titan query embedding calls are counted but not priced in the report; the existing estimated totals cover Nova calls only. Other regions, cross-region profiles, unsupported tiers, cached-token rates or missing usage do not receive invented prices.

## Indexing flow

```mermaid
flowchart LR
  PDF[Four allowlisted synthetic PDFs] --> TEXT[PDF.js page text]
  TEXT --> CH[Deterministic page-aware chunks]
  CH --> EM[Titan Text Embeddings V2]
  EM --> PG[(Local PostgreSQL + pgvector)]
```

`packages/indexing` preserves stable IDs, one-based page numbers, zero-based chunk indexes, exact PDF.js text slices, UTF-16 offsets and SHA-256 hashes. Its provider interface isolates embedding calls from chunking and storage. The Titan provider uses `amazon.titan-embed-text-v2:0`, `ap-southeast-2` and 1,024 dimensions. Matching content hash, chunker version and embedding metadata skip model calls and writes. A changed document replaces its chunks in one transaction; failed embedding or storage leaves the prior document intact.

The four synthetic PDFs are allowlisted for manual indexing. Concurrent indexing of the same changed document can duplicate billable embedding calls.

## Retrieval flow

```mermaid
flowchart LR
  Q[Natural-language query + explicit document IDs] --> V[Validate inputs and indexed metadata]
  V --> E[Titan V2 query embedding]
  E --> S[pgvector exact cosine search]
  S --> O[Ranked original passages + provenance]
```

`packages/retrieval` checks each requested document before embedding the query. It requires `amazon.titan-embed-text-v2:0`, `ap-southeast-2` and 1,024 dimensions, and rejects missing documents or documents without compatible chunks. A parameterized SQL query applies the document allowlist and embedding metadata filters to both `source_documents` and `document_chunks`; `embedding <=> query_vector` sorts by ascending cosine distance with a bounded limit. No approximate vector index is used. Results retain source name, one-based page, zero-based chunk index, exact stored text, UTF-16 offsets and content hash. Assessment RAG mode also checks current PDF content hashes and chunker version before retrieval; it never reindexes or writes to the database.

## Scope and next steps

The CLI uses synthetic PDFs only. PDF.js does not OCR scans, and the evidence checks are tuned to their wording. Similarity-ranked passages are candidates for evidence, not proof of a claim. With only two or three chunks per document, RAG may send most of the source text while adding seven Titan calls. TopK 2 can still miss a relevant passage, and no quality or cost advantage is assumed without paired offline evaluation. There is no LangGraph, LangSmith, API, reviewer interface or AWS deployment.

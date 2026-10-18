CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS source_documents (
  document_id text PRIMARY KEY,
  source_name text NOT NULL,
  content_sha256 char(64) NOT NULL,
  page_count integer NOT NULL CHECK (page_count > 0),
  chunker_version text NOT NULL,
  embedding_model_id text NOT NULL,
  embedding_region text NOT NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions = 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_chunks (
  document_id text NOT NULL REFERENCES source_documents(document_id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  page_number integer NOT NULL CHECK (page_number >= 1),
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  end_offset integer NOT NULL CHECK (end_offset > start_offset),
  original_text text NOT NULL,
  content_sha256 char(64) NOT NULL,
  embedding vector(1024) NOT NULL,
  embedding_model_id text NOT NULL,
  embedding_region text NOT NULL,
  embedding_dimensions integer NOT NULL CHECK (embedding_dimensions = 1024),
  embedded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS document_chunks_page_idx
  ON document_chunks (document_id, page_number, chunk_index);

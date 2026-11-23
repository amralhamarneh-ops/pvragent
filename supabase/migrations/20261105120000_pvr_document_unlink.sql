-- Removing a document from a PVR unlinks it (soft removal). The row and the stored original are kept,
-- so historical assessment versions and their provenance stay intact. Role changes keep an audit history.
-- Additive and idempotent.

ALTER TABLE public.pvr_case_documents ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE public.pvr_case_documents ADD COLUMN IF NOT EXISTS role_manual BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.pvr_case_documents ADD COLUMN IF NOT EXISTS role_history JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.pvr_case_documents ADD COLUMN IF NOT EXISTS subrole TEXT NOT NULL DEFAULT '';
ALTER TABLE public.pvr_case_documents ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.pvr_case_documents ADD COLUMN IF NOT EXISTS replaced_by TEXT;

CREATE INDEX IF NOT EXISTS idx_pvr_case_documents_active ON public.pvr_case_documents(case_id) WHERE removed_at IS NULL;

-- Current analysis results are marked stale when the document set changes; versions are never deleted.
ALTER TABLE public.pvr_case_evidence ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.pvr_case_evidence ADD COLUMN IF NOT EXISTS stale_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE public.pvr_case_evidence ADD COLUMN IF NOT EXISTS stale_at TIMESTAMPTZ;

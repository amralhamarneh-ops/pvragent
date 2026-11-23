-- Shared document registry and persisted case evidence.
-- Additive and safe to run more than once, and safe on a database where the earlier
-- pvr_* migrations have NOT been applied (prerequisites are created idempotently below).
-- Files live in the PRIVATE bucket pvr-boq-files under <owner uid>/<case id>/docs/...

-- 0. Prerequisites (no-ops when the earlier migrations were already applied).
CREATE TABLE IF NOT EXISTS public.pvr_cases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'real' CHECK (mode IN ('real', 'demo')),
    currency TEXT NOT NULL,
    selected_import_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.pvr_cases ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.pvr_cases ALTER COLUMN owner_id SET DEFAULT auth.uid();
CREATE INDEX IF NOT EXISTS idx_pvr_cases_owner ON public.pvr_cases(owner_id);

ALTER TABLE public.pvr_cases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pvr_cases FROM anon;

DROP POLICY IF EXISTS "pvr_cases_owner_select" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_select" ON public.pvr_cases FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_cases_owner_insert" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_insert" ON public.pvr_cases FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_cases_owner_update" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_update" ON public.pvr_cases FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_cases_owner_delete" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_delete" ON public.pvr_cases FOR DELETE TO authenticated USING (owner_id = auth.uid());

CREATE OR REPLACE FUNCTION public.pvr_enforce_child_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    case_owner UUID;
BEGIN
    SELECT c.owner_id INTO case_owner FROM public.pvr_cases c WHERE c.id = NEW.case_id LIMIT 1;
    IF case_owner IS NULL THEN
        RAISE EXCEPTION 'Case % does not exist or has no owner', NEW.case_id USING ERRCODE = '42501';
    END IF;
    IF case_owner IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'Not permitted to write to case %', NEW.case_id USING ERRCODE = '42501';
    END IF;
    NEW.owner_id := case_owner;
    RETURN NEW;
END;
$func$;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('pvr-boq-files', 'pvr-boq-files', false, 26214400)
ON CONFLICT (id) DO UPDATE SET public = false;

DROP POLICY IF EXISTS "pvr_boq_files_owner_select" ON storage.objects;
CREATE POLICY "pvr_boq_files_owner_select" ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "pvr_boq_files_owner_insert" ON storage.objects;
CREATE POLICY "pvr_boq_files_owner_insert" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "pvr_boq_files_owner_update" ON storage.objects;
CREATE POLICY "pvr_boq_files_owner_update" ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "pvr_boq_files_owner_delete" ON storage.objects;
CREATE POLICY "pvr_boq_files_owner_delete" ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = auth.uid()::text);

-- 1. Document registry.
CREATE TABLE IF NOT EXISTS public.pvr_case_documents (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT auth.uid(),
    file_name TEXT NOT NULL,
    path TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'unused',
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    storage_path TEXT,
    stored BOOLEAN NOT NULL DEFAULT FALSE,
    state TEXT NOT NULL DEFAULT 'uploaded',
    state_detail TEXT NOT NULL DEFAULT '',
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_case_documents_case ON public.pvr_case_documents(case_id);
CREATE INDEX IF NOT EXISTS idx_pvr_case_documents_owner ON public.pvr_case_documents(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pvr_case_documents_case_path_hash ON public.pvr_case_documents(case_id, path, sha256);

-- 2. One evidence record per case: original narrative, structured handoff, applied answers.
CREATE TABLE IF NOT EXISTS public.pvr_case_evidence (
    case_id TEXT PRIMARY KEY REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT auth.uid(),
    narrative TEXT NOT NULL DEFAULT '',
    handoff JSONB,
    answers JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_case_evidence_owner ON public.pvr_case_evidence(owner_id);

ALTER TABLE public.pvr_case_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_case_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pvr_case_documents FROM anon;
REVOKE ALL ON public.pvr_case_evidence FROM anon;

DROP TRIGGER IF EXISTS pvr_case_documents_owner_guard ON public.pvr_case_documents;
CREATE TRIGGER pvr_case_documents_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_case_documents
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

DROP TRIGGER IF EXISTS pvr_case_evidence_owner_guard ON public.pvr_case_evidence;
CREATE TRIGGER pvr_case_evidence_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_case_evidence
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

DROP POLICY IF EXISTS "pvr_case_documents_owner_select" ON public.pvr_case_documents;
CREATE POLICY "pvr_case_documents_owner_select" ON public.pvr_case_documents FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_case_documents_owner_insert" ON public.pvr_case_documents;
CREATE POLICY "pvr_case_documents_owner_insert" ON public.pvr_case_documents FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_case_documents_owner_update" ON public.pvr_case_documents;
CREATE POLICY "pvr_case_documents_owner_update" ON public.pvr_case_documents FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "pvr_case_evidence_owner_select" ON public.pvr_case_evidence;
CREATE POLICY "pvr_case_evidence_owner_select" ON public.pvr_case_evidence FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_case_evidence_owner_insert" ON public.pvr_case_evidence;
CREATE POLICY "pvr_case_evidence_owner_insert" ON public.pvr_case_evidence FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_case_evidence_owner_update" ON public.pvr_case_evidence;
CREATE POLICY "pvr_case_evidence_owner_update" ON public.pvr_case_evidence FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- No delete policy: documents and evidence are retained.

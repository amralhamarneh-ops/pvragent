-- Original BOQ file storage metadata and saved calculations (revision invalidation).
-- Additive and data-preserving. Safe to run more than once.
-- Run AFTER 20261029190000_pvr_boq_owner_rls.sql.
--
-- Also defensively removes ANY leftover permissive policy on the pvr_* tables and on the pvr-boq-files bucket
-- (by name pattern and by "always true" qualifier), so an obsolete anonymous policy cannot survive alongside
-- the owner-only ones. Policies are permissive by default, so one leftover "true" policy would defeat the rest.

-- 1. File storage metadata on imports.
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS original_file_name TEXT;
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ;
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS file_stored BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Saved calculations. Immutable evidence: the app inserts and may mark a review, but never edits numbers.
CREATE TABLE IF NOT EXISTS public.pvr_calculations (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT auth.uid(),
    import_id TEXT NOT NULL REFERENCES public.pvr_boq_imports(id) ON DELETE RESTRICT,
    import_revision INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    signed_amount TEXT NOT NULL,
    reviewed_against_import_id TEXT,
    record JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_calculations_case ON public.pvr_calculations(case_id);
CREATE INDEX IF NOT EXISTS idx_pvr_calculations_owner ON public.pvr_calculations(owner_id);

ALTER TABLE public.pvr_calculations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pvr_calculations FROM anon;

DROP TRIGGER IF EXISTS pvr_calculations_owner_guard ON public.pvr_calculations;
CREATE TRIGGER pvr_calculations_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_calculations
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

-- Numbers and evidence are immutable. Only the review marker may change.
CREATE OR REPLACE FUNCTION public.pvr_calculation_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $func$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.import_id IS DISTINCT FROM OLD.import_id
       OR NEW.import_revision IS DISTINCT FROM OLD.import_revision
       OR NEW.item_id IS DISTINCT FROM OLD.item_id
       OR NEW.signed_amount IS DISTINCT FROM OLD.signed_amount
       OR NEW.record - 'reviewedAgainstImportId' IS DISTINCT FROM OLD.record - 'reviewedAgainstImportId' THEN
        RAISE EXCEPTION 'A saved calculation is evidence and cannot be edited. Create a new calculation instead.' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS pvr_calculations_immutable ON public.pvr_calculations;
CREATE TRIGGER pvr_calculations_immutable BEFORE UPDATE ON public.pvr_calculations
FOR EACH ROW EXECUTE FUNCTION public.pvr_calculation_immutable();

DROP POLICY IF EXISTS "pvr_calculations_owner_select" ON public.pvr_calculations;
CREATE POLICY "pvr_calculations_owner_select" ON public.pvr_calculations FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_calculations_owner_insert" ON public.pvr_calculations;
CREATE POLICY "pvr_calculations_owner_insert" ON public.pvr_calculations FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_calculations_owner_update" ON public.pvr_calculations;
CREATE POLICY "pvr_calculations_owner_update" ON public.pvr_calculations FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
-- No delete policy: calculations are retained as evidence.

-- 3. Remove obsolete permissive policies. Keeps only the named owner-only policies.
DO $cleanup$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('pvr_cases', 'pvr_boq_imports', 'pvr_boq_rows', 'pvr_calculations')
          AND policyname NOT LIKE '%\_owner\_%' ESCAPE '\'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    END LOOP;

    -- Storage: only touch policies that mention the BOQ bucket and are not the owner-folder policies.
    FOR pol IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'storage' AND tablename = 'objects'
          AND (coalesce(qual, '') ILIKE '%pvr-boq-files%' OR coalesce(with_check, '') ILIKE '%pvr-boq-files%')
          AND policyname NOT LIKE 'pvr\_boq\_files\_owner\_%' ESCAPE '\'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    END LOOP;
END
$cleanup$;

REVOKE ALL ON public.pvr_cases FROM anon;
REVOKE ALL ON public.pvr_boq_imports FROM anon;
REVOKE ALL ON public.pvr_boq_rows FROM anon;

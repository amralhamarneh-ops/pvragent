-- Owner-scoped access for BOQ cases, imports and rows.
-- Replaces the unrestricted anonymous policies from 20261029180000_pvr_boq_cases.sql.
-- Additive and data-preserving: no table is dropped or recreated, no row is deleted.
-- Safe to run more than once.
--
-- Access model
--   * A case belongs to exactly one signed-in user (pvr_cases.owner_id = auth.uid()).
--   * Imports and rows are reachable only through a case the signed-in user owns.
--   * Knowing a case id grants nothing. The anon role has no access at all.
--   * Service-role credentials are not used by the application.

-- 1. Ownership columns (nullable first so any existing rows are preserved).
ALTER TABLE public.pvr_cases ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS owner_id UUID;
ALTER TABLE public.pvr_boq_rows ADD COLUMN IF NOT EXISTS owner_id UUID;

-- 2. Backfill imports and rows from their case (no-op when there are no rows).
UPDATE public.pvr_boq_imports i SET owner_id = c.owner_id FROM public.pvr_cases c WHERE i.case_id = c.id AND i.owner_id IS NULL AND c.owner_id IS NOT NULL;
UPDATE public.pvr_boq_rows r SET owner_id = c.owner_id FROM public.pvr_cases c WHERE r.case_id = c.id AND r.owner_id IS NULL AND c.owner_id IS NOT NULL;

-- 3. Ownership defaults to the caller, so a client can never insert a row for someone else.
ALTER TABLE public.pvr_cases ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.pvr_boq_imports ALTER COLUMN owner_id SET DEFAULT auth.uid();
ALTER TABLE public.pvr_boq_rows ALTER COLUMN owner_id SET DEFAULT auth.uid();

CREATE INDEX IF NOT EXISTS idx_pvr_cases_owner ON public.pvr_cases(owner_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_imports_owner ON public.pvr_boq_imports(owner_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_rows_owner ON public.pvr_boq_rows(owner_id);

-- 4. Consistency: an import/row owner must match its case owner. Enforced by triggers so a
--    client cannot attach rows to a case it does not own, even with a guessed case id.
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

DROP TRIGGER IF EXISTS pvr_boq_imports_owner_guard ON public.pvr_boq_imports;
CREATE TRIGGER pvr_boq_imports_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_boq_imports
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

DROP TRIGGER IF EXISTS pvr_boq_rows_owner_guard ON public.pvr_boq_rows;
CREATE TRIGGER pvr_boq_rows_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_boq_rows
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

-- A case can only select an import that belongs to that same case (revision selection guard).
CREATE OR REPLACE FUNCTION public.pvr_guard_selected_import()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
    IF NEW.selected_import_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.pvr_boq_imports i
            WHERE i.id = NEW.selected_import_id AND i.case_id = NEW.id AND i.confirmed_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'selected_import_id must be a confirmed import of this case' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS pvr_cases_selected_import_guard ON public.pvr_cases;
CREATE TRIGGER pvr_cases_selected_import_guard BEFORE INSERT OR UPDATE OF selected_import_id ON public.pvr_cases
FOR EACH ROW EXECUTE FUNCTION public.pvr_guard_selected_import();

-- 5. RLS. Remove the unrestricted anonymous policies first.
ALTER TABLE public.pvr_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_boq_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_boq_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pvr_cases_anon_all" ON public.pvr_cases;
DROP POLICY IF EXISTS "pvr_boq_imports_anon_all" ON public.pvr_boq_imports;
DROP POLICY IF EXISTS "pvr_boq_rows_anon_all" ON public.pvr_boq_rows;

REVOKE ALL ON public.pvr_cases FROM anon;
REVOKE ALL ON public.pvr_boq_imports FROM anon;
REVOKE ALL ON public.pvr_boq_rows FROM anon;

DROP POLICY IF EXISTS "pvr_cases_owner_select" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_select" ON public.pvr_cases FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_cases_owner_insert" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_insert" ON public.pvr_cases FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_cases_owner_update" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_update" ON public.pvr_cases FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_cases_owner_delete" ON public.pvr_cases;
CREATE POLICY "pvr_cases_owner_delete" ON public.pvr_cases FOR DELETE TO authenticated USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "pvr_boq_imports_owner_select" ON public.pvr_boq_imports;
CREATE POLICY "pvr_boq_imports_owner_select" ON public.pvr_boq_imports FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_boq_imports_owner_insert" ON public.pvr_boq_imports;
CREATE POLICY "pvr_boq_imports_owner_insert" ON public.pvr_boq_imports FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_boq_imports_owner_update" ON public.pvr_boq_imports;
CREATE POLICY "pvr_boq_imports_owner_update" ON public.pvr_boq_imports FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_boq_imports_owner_delete" ON public.pvr_boq_imports;
CREATE POLICY "pvr_boq_imports_owner_delete" ON public.pvr_boq_imports FOR DELETE TO authenticated USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "pvr_boq_rows_owner_select" ON public.pvr_boq_rows;
CREATE POLICY "pvr_boq_rows_owner_select" ON public.pvr_boq_rows FOR SELECT TO authenticated USING (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_boq_rows_owner_insert" ON public.pvr_boq_rows;
CREATE POLICY "pvr_boq_rows_owner_insert" ON public.pvr_boq_rows FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_boq_rows_owner_update" ON public.pvr_boq_rows;
CREATE POLICY "pvr_boq_rows_owner_update" ON public.pvr_boq_rows FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
DROP POLICY IF EXISTS "pvr_boq_rows_owner_delete" ON public.pvr_boq_rows;
CREATE POLICY "pvr_boq_rows_owner_delete" ON public.pvr_boq_rows FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- 6. Private storage for original uploaded BOQ files. Path convention: <owner uid>/<case id>/<file>.
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

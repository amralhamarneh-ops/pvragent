-- Staged BOQ import persistence. Additive and idempotent. Drops nothing, deletes nothing.
-- Existing imports are backfilled as 'complete' so current cases keep working unchanged.
--
-- Model
--   * pvr_boq_imports.import_status: 'pending' until every expected batch and row is verified, then 'complete'.
--   * pvr_boq_import_batches: one ledger row per batch (stable id, checksum, row count). Re-sending a batch is a no-op.
--   * pvr_boq_rows.batch_id: which batch wrote the row. Row ids are deterministic (<import>:<row id>), so a replay
--     of a batch can never duplicate a row.
--   * pvr_finalise_boq_import(): verifies completeness and publishes in ONE transaction. Only 'complete' imports
--     may become confirmed or be selected, so a partial import cannot be used by calculations.

ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS import_status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS expected_rows INTEGER;
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS expected_batches INTEGER;
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS import_checksum TEXT;
ALTER TABLE public.pvr_boq_imports ADD COLUMN IF NOT EXISTS pending_confirmed_at TIMESTAMPTZ;

DO $do$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pvr_boq_imports_status_chk') THEN
        ALTER TABLE public.pvr_boq_imports ADD CONSTRAINT pvr_boq_imports_status_chk CHECK (import_status IN ('pending', 'complete'));
    END IF;
END
$do$;

ALTER TABLE public.pvr_boq_rows ADD COLUMN IF NOT EXISTS batch_id TEXT;

CREATE TABLE IF NOT EXISTS public.pvr_boq_import_batches (
    batch_id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES public.pvr_boq_imports(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    batch_index INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (import_id, batch_index)
);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_import_batches_import ON public.pvr_boq_import_batches(import_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_rows_import_order ON public.pvr_boq_rows(import_id, sheet, row_number);

ALTER TABLE public.pvr_boq_import_batches ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS pvr_boq_import_batches_owner_guard ON public.pvr_boq_import_batches;
CREATE TRIGGER pvr_boq_import_batches_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_boq_import_batches
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

DO $do$
DECLARE
    guest CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
    t CONSTANT TEXT := 'pvr_boq_import_batches';
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())', t || '_owner_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())', t || '_owner_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t || '_owner_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (owner_id = auth.uid())', t || '_owner_delete', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_select', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (owner_id = %L::uuid)', t || '_guest_select', t, guest);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (owner_id = %L::uuid)', t || '_guest_insert', t, guest);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', t || '_guest_update', t, guest, guest);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_delete', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO anon USING (owner_id = %L::uuid)', t || '_guest_delete', t, guest);
END
$do$;

-- A pending import can never be confirmed or selected. Defence in depth behind the application checks.
CREATE OR REPLACE FUNCTION public.pvr_guard_pending_confirm()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $func$
BEGIN
    IF NEW.import_status = 'pending' AND NEW.confirmed_at IS NOT NULL THEN
        RAISE EXCEPTION 'A pending import cannot be confirmed until every batch is verified' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS pvr_boq_imports_pending_guard ON public.pvr_boq_imports;
CREATE TRIGGER pvr_boq_imports_pending_guard BEFORE INSERT OR UPDATE ON public.pvr_boq_imports
FOR EACH ROW EXECUTE FUNCTION public.pvr_guard_pending_confirm();

-- Selection additionally requires a complete import.
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
            WHERE i.id = NEW.selected_import_id AND i.case_id = NEW.id AND i.confirmed_at IS NOT NULL AND i.import_status = 'complete'
        ) THEN
            RAISE EXCEPTION 'selected_import_id must be a confirmed, complete import of this case' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$func$;

-- Atomic publish. Verifies the batch ledger and the stored row count against what was declared at initialise,
-- then marks the import complete and confirmed in one transaction. Runs as the caller (RLS and owner triggers apply).
CREATE OR REPLACE FUNCTION public.pvr_finalise_boq_import(p_case_id TEXT, p_import_id TEXT, p_import_checksum TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $func$
DECLARE
    imp public.pvr_boq_imports%ROWTYPE;
    batch_n INTEGER;
    batch_rows INTEGER;
    row_n INTEGER;
    sel TEXT;
BEGIN
    SELECT * INTO imp FROM public.pvr_boq_imports WHERE id = p_import_id AND case_id = p_case_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'message', 'That import was not found for this case.');
    END IF;
    IF imp.import_status = 'complete' THEN
        RETURN jsonb_build_object('ok', true, 'already', true, 'savedRows', COALESCE(imp.expected_rows, 0), 'savedBatches', COALESCE(imp.expected_batches, 0));
    END IF;
    IF imp.import_checksum IS DISTINCT FROM p_import_checksum THEN
        RETURN jsonb_build_object('ok', false, 'code', 'checksum_mismatch', 'message', 'The import checksum does not match the one declared at initialise.');
    END IF;
    SELECT COUNT(*), COALESCE(SUM(row_count), 0) INTO batch_n, batch_rows FROM public.pvr_boq_import_batches WHERE import_id = p_import_id;
    SELECT COUNT(*) INTO row_n FROM public.pvr_boq_rows WHERE import_id = p_import_id;
    IF batch_n <> imp.expected_batches OR batch_rows <> imp.expected_rows OR row_n <> imp.expected_rows THEN
        RETURN jsonb_build_object('ok', false, 'code', 'incomplete', 'message', 'The import is not complete yet.', 'savedBatches', batch_n, 'expectedBatches', imp.expected_batches, 'savedRows', row_n, 'expectedRows', imp.expected_rows);
    END IF;

    UPDATE public.pvr_boq_imports SET import_status = 'complete', confirmed_at = COALESCE(pending_confirmed_at, confirmed_at) WHERE id = p_import_id;

    -- The first confirmed import is selected automatically. Later imports never switch the selection silently.
    IF (SELECT pending_confirmed_at FROM public.pvr_boq_imports WHERE id = p_import_id) IS NOT NULL THEN
        SELECT selected_import_id INTO sel FROM public.pvr_cases WHERE id = p_case_id;
        IF sel IS NULL THEN
            UPDATE public.pvr_cases SET selected_import_id = p_import_id WHERE id = p_case_id;
        END IF;
    END IF;
    RETURN jsonb_build_object('ok', true, 'already', false, 'savedRows', row_n, 'savedBatches', batch_n);
END;
$func$;

GRANT EXECUTE ON FUNCTION public.pvr_finalise_boq_import(TEXT, TEXT, TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

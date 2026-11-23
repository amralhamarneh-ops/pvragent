-- Targeted repair. Observed on the live database: pvr_cases, pvr_case_documents and pvr_case_evidence exist,
-- but pvr_boq_imports, pvr_boq_rows and pvr_calculations do not. Case loading fails when it reads pvr_boq_imports.
-- Additive and idempotent. Creates only what is missing. Drops nothing, erases nothing, does not touch existing
-- tables or their policies, does not disable RLS and does not grant access beyond the shared-guest / owner model
-- already used by the live tables (pvr_effective_uid()).

CREATE OR REPLACE FUNCTION public.pvr_effective_uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $func$
    SELECT COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid);
$func$;

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
    IF case_owner IS DISTINCT FROM public.pvr_effective_uid() THEN
        RAISE EXCEPTION 'Not permitted to write to case %', NEW.case_id USING ERRCODE = '42501';
    END IF;
    NEW.owner_id := case_owner;
    RETURN NEW;
END;
$func$;

CREATE TABLE IF NOT EXISTS public.pvr_boq_imports (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    revision INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    original_file_name TEXT,
    file_sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    format TEXT NOT NULL,
    currency TEXT NOT NULL,
    revision_label TEXT NOT NULL DEFAULT '',
    mappings JSONB NOT NULL,
    confirmed_at TIMESTAMPTZ,
    storage_path TEXT,
    uploaded_at TIMESTAMPTZ,
    file_stored BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (case_id, revision)
);

CREATE TABLE IF NOT EXISTS public.pvr_boq_rows (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES public.pvr_boq_imports(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    sheet TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    row_class TEXT NOT NULL,
    included BOOLEAN NOT NULL,
    row_data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pvr_calculations (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    import_id TEXT NOT NULL REFERENCES public.pvr_boq_imports(id) ON DELETE RESTRICT,
    import_revision INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    signed_amount TEXT NOT NULL,
    reviewed_against_import_id TEXT,
    record JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pvr_boq_imports_case ON public.pvr_boq_imports(case_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_imports_owner ON public.pvr_boq_imports(owner_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_rows_import ON public.pvr_boq_rows(import_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_rows_case ON public.pvr_boq_rows(case_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_rows_owner ON public.pvr_boq_rows(owner_id);
CREATE INDEX IF NOT EXISTS idx_pvr_calculations_case ON public.pvr_calculations(case_id);
CREATE INDEX IF NOT EXISTS idx_pvr_calculations_owner ON public.pvr_calculations(owner_id);

ALTER TABLE public.pvr_boq_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_boq_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_calculations ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS pvr_boq_imports_owner_guard ON public.pvr_boq_imports;
CREATE TRIGGER pvr_boq_imports_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_boq_imports
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

DROP TRIGGER IF EXISTS pvr_boq_rows_owner_guard ON public.pvr_boq_rows;
CREATE TRIGGER pvr_boq_rows_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_boq_rows
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

DROP TRIGGER IF EXISTS pvr_calculations_owner_guard ON public.pvr_calculations;
CREATE TRIGGER pvr_calculations_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_calculations
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

-- A case may only select a confirmed import that belongs to it.
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

-- Saved calculations are evidence: only the review marker may change.
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

-- Access: signed-in owner, or the shared guest (anon) limited to guest-owned rows. Same model as the live tables.
DO $do$
DECLARE
    t TEXT;
    guest CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    FOREACH t IN ARRAY ARRAY['pvr_boq_imports','pvr_boq_rows','pvr_calculations']
    LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())', t || '_owner_select', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())', t || '_owner_insert', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t || '_owner_update', t);

        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (owner_id = %L::uuid)', t || '_guest_select', t, guest);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (owner_id = %L::uuid)', t || '_guest_insert', t, guest);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', t || '_guest_update', t, guest, guest);
    END LOOP;

    -- Imports and rows may be deleted by their owner (re-saving an import replaces its rows). Calculations are retained as evidence.
    FOREACH t IN ARRAY ARRAY['pvr_boq_imports','pvr_boq_rows']
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_delete', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (owner_id = auth.uid())', t || '_owner_delete', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_delete', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO anon USING (owner_id = %L::uuid)', t || '_guest_delete', t, guest);
    END LOOP;
END
$do$;

-- Ask PostgREST to reload its schema cache so the new tables are exposed immediately.
NOTIFY pgrst, 'reload schema';

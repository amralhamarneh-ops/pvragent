-- Reference Cases & Learning (Admin Kit).
-- Additive and idempotent. Files are stored in the PRIVATE bucket pvr-boq-files under <owner uid>/reference/<case id>/...
-- A reference case is a LIBRARY record. Being available as a reference is NOT model training:
-- used_in_fine_tuning is permanently FALSE (CHECK constraint) and no code path sets it.

CREATE TABLE IF NOT EXISTS public.pvr_reference_cases (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT auth.uid(),
    case_group TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'under_review', 'approved', 'retired')),
    partition TEXT NOT NULL DEFAULT 'learning' CHECK (partition IN ('learning', 'evaluation')),
    record JSONB NOT NULL DEFAULT '{}'::jsonb,
    missing_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
    review_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    replaced_by TEXT,
    used_in_fine_tuning BOOLEAN NOT NULL DEFAULT FALSE CHECK (used_in_fine_tuning = FALSE),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_reference_cases_owner ON public.pvr_reference_cases(owner_id);
CREATE INDEX IF NOT EXISTS idx_pvr_reference_cases_status ON public.pvr_reference_cases(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pvr_reference_cases_group_version ON public.pvr_reference_cases(owner_id, case_group, version);

CREATE TABLE IF NOT EXISTS public.pvr_reference_sources (
    id TEXT PRIMARY KEY,
    reference_id TEXT NOT NULL REFERENCES public.pvr_reference_cases(id) ON DELETE CASCADE,
    owner_id UUID NOT NULL DEFAULT auth.uid(),
    role TEXT NOT NULL,
    file_name TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    storage_path TEXT,
    stored BOOLEAN NOT NULL DEFAULT FALSE,
    read_status TEXT NOT NULL DEFAULT 'not_read',
    read_detail TEXT NOT NULL DEFAULT '',
    text_excerpt TEXT NOT NULL DEFAULT '',
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_reference_sources_ref ON public.pvr_reference_sources(reference_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pvr_reference_sources_ref_hash ON public.pvr_reference_sources(reference_id, sha256);

CREATE TABLE IF NOT EXISTS public.pvr_reference_evaluations (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT auth.uid(),
    run_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_pvr_reference_evaluations_owner ON public.pvr_reference_evaluations(owner_id);

CREATE OR REPLACE FUNCTION public.pvr_reference_owner_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.owner_id := COALESCE(NEW.owner_id, auth.uid());
    ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
        RAISE EXCEPTION 'owner_id cannot be changed' USING ERRCODE = '42501';
    END IF;
    IF TG_TABLE_NAME = 'pvr_reference_cases' THEN
        NEW.updated_at := CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$func$;

DROP TRIGGER IF EXISTS pvr_reference_cases_guard ON public.pvr_reference_cases;
CREATE TRIGGER pvr_reference_cases_guard BEFORE INSERT OR UPDATE ON public.pvr_reference_cases
FOR EACH ROW EXECUTE FUNCTION public.pvr_reference_owner_guard();
DROP TRIGGER IF EXISTS pvr_reference_sources_guard ON public.pvr_reference_sources;
CREATE TRIGGER pvr_reference_sources_guard BEFORE INSERT OR UPDATE ON public.pvr_reference_sources
FOR EACH ROW EXECUTE FUNCTION public.pvr_reference_owner_guard();

ALTER TABLE public.pvr_reference_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_reference_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_reference_evaluations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pvr_reference_cases FROM anon;
REVOKE ALL ON public.pvr_reference_sources FROM anon;
REVOKE ALL ON public.pvr_reference_evaluations FROM anon;

DO $do$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['pvr_reference_cases', 'pvr_reference_sources', 'pvr_reference_evaluations'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())', t || '_owner_select', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())', t || '_owner_insert', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t || '_owner_update', t);
        -- Guest mode (sign-in switched off): the shared guest identity may use its own rows only.
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_all', t);
    END LOOP;
END
$do$;
-- No delete policy: reference cases are retired or replaced, never deleted, so provenance is retained.

-- Guest access (matches the existing guest identity used by the other pvr_* tables).
GRANT SELECT, INSERT, UPDATE ON public.pvr_reference_cases TO anon;
GRANT SELECT, INSERT, UPDATE ON public.pvr_reference_sources TO anon;
GRANT SELECT, INSERT ON public.pvr_reference_evaluations TO anon;
DO $do$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['pvr_reference_cases', 'pvr_reference_sources', 'pvr_reference_evaluations'] LOOP
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (owner_id = %L::uuid)', t || '_guest_select', t, '00000000-0000-0000-0000-000000000001');
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (owner_id = %L::uuid)', t || '_guest_insert', t, '00000000-0000-0000-0000-000000000001');
    END LOOP;
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', 'pvr_reference_cases_guest_update', 'pvr_reference_cases', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', 'pvr_reference_sources_guest_update', 'pvr_reference_sources', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');
EXCEPTION WHEN duplicate_object THEN
    NULL;
END
$do$;

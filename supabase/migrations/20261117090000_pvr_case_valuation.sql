-- Case-scoped valuation decisions: manual rates, exclusions, deferrals, assessment items, aggregation groups,
-- replacement methods and the source fingerprint the decisions were made against.
-- Additive and idempotent. One row per case. Touches no existing table and drops nothing.

CREATE TABLE IF NOT EXISTS public.pvr_case_valuation (
    case_id TEXT PRIMARY KEY REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    decisions JSONB NOT NULL DEFAULT '{}'::jsonb,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    groups JSONB NOT NULL DEFAULT '[]'::jsonb,
    replacements JSONB NOT NULL DEFAULT '[]'::jsonb,
    fingerprint JSONB,
    stale BOOLEAN NOT NULL DEFAULT FALSE,
    stale_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pvr_case_valuation_owner ON public.pvr_case_valuation(owner_id);

ALTER TABLE public.pvr_case_valuation ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS pvr_case_valuation_owner_guard ON public.pvr_case_valuation;
CREATE TRIGGER pvr_case_valuation_owner_guard BEFORE INSERT OR UPDATE ON public.pvr_case_valuation
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

DO $do$
DECLARE
    guest CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    GRANT SELECT, INSERT, UPDATE ON public.pvr_case_valuation TO anon;
    GRANT SELECT, INSERT, UPDATE ON public.pvr_case_valuation TO authenticated;

    DROP POLICY IF EXISTS pvr_case_valuation_owner_select ON public.pvr_case_valuation;
    CREATE POLICY pvr_case_valuation_owner_select ON public.pvr_case_valuation FOR SELECT TO authenticated USING (owner_id = auth.uid());
    DROP POLICY IF EXISTS pvr_case_valuation_owner_insert ON public.pvr_case_valuation;
    CREATE POLICY pvr_case_valuation_owner_insert ON public.pvr_case_valuation FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
    DROP POLICY IF EXISTS pvr_case_valuation_owner_update ON public.pvr_case_valuation;
    CREATE POLICY pvr_case_valuation_owner_update ON public.pvr_case_valuation FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

    DROP POLICY IF EXISTS pvr_case_valuation_guest_select ON public.pvr_case_valuation;
    EXECUTE format('CREATE POLICY pvr_case_valuation_guest_select ON public.pvr_case_valuation FOR SELECT TO anon USING (owner_id = %L::uuid)', guest);
    DROP POLICY IF EXISTS pvr_case_valuation_guest_insert ON public.pvr_case_valuation;
    EXECUTE format('CREATE POLICY pvr_case_valuation_guest_insert ON public.pvr_case_valuation FOR INSERT TO anon WITH CHECK (owner_id = %L::uuid)', guest);
    DROP POLICY IF EXISTS pvr_case_valuation_guest_update ON public.pvr_case_valuation;
    EXECUTE format('CREATE POLICY pvr_case_valuation_guest_update ON public.pvr_case_valuation FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', guest, guest);
END
$do$;

NOTIFY pgrst, 'reload schema';

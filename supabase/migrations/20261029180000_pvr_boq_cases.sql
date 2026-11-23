-- Real BOQ import cases. Additive only: existing tables are untouched.
-- Apply in the Supabase SQL editor (Project -> SQL Editor), then re-open the case in the app.

CREATE TABLE IF NOT EXISTS public.pvr_cases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'real' CHECK (mode IN ('real', 'demo')),
    currency TEXT NOT NULL,
    selected_import_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.pvr_boq_imports (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    format TEXT NOT NULL,
    currency TEXT NOT NULL,
    revision_label TEXT NOT NULL DEFAULT '',
    mappings JSONB NOT NULL,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (case_id, revision)
);

CREATE TABLE IF NOT EXISTS public.pvr_boq_rows (
    id TEXT PRIMARY KEY,
    import_id TEXT NOT NULL REFERENCES public.pvr_boq_imports(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    sheet TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    row_class TEXT NOT NULL,
    included BOOLEAN NOT NULL,
    row_data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pvr_boq_imports_case ON public.pvr_boq_imports(case_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_rows_import ON public.pvr_boq_rows(import_id);
CREATE INDEX IF NOT EXISTS idx_pvr_boq_rows_case ON public.pvr_boq_rows(case_id);

ALTER TABLE public.pvr_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_boq_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_boq_rows ENABLE ROW LEVEL SECURITY;

-- BLOCKER: the app has no signed-in user session yet, so these policies must allow the anon role.
-- Replace with per-user / per-project policies when Supabase Auth is wired into the app.
DROP POLICY IF EXISTS "pvr_cases_anon_all" ON public.pvr_cases;
CREATE POLICY "pvr_cases_anon_all" ON public.pvr_cases FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "pvr_boq_imports_anon_all" ON public.pvr_boq_imports;
CREATE POLICY "pvr_boq_imports_anon_all" ON public.pvr_boq_imports FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "pvr_boq_rows_anon_all" ON public.pvr_boq_rows;
CREATE POLICY "pvr_boq_rows_anon_all" ON public.pvr_boq_rows FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

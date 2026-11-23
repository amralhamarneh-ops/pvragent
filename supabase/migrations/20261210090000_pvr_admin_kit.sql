-- Admin Kit: versioned agent configuration, agent run records, notification/workflow configuration and delivery log.
-- Additive and idempotent. Nothing is deleted: configuration versions and deliveries are append-only history.
--
-- pvr_agent_configs       one row per (agent, version). status: draft | tested | published | superseded.
--                         `rules` holds ONLY editable business rules. Protected calculation, ownership and security
--                         controls live in code and are never read from this table.
-- pvr_agent_pointer       which version is published for each agent (changing it is what Publish / Roll back do).
-- pvr_agent_runs          one row per real agent execution, pinned to the config version it started with.
-- pvr_notification_rules  trigger / roles / channel / template / approvals / escalation. Live delivery needs enabled = true.
-- pvr_notification_deliveries  one row per (rule, event, recipient) with a unique idempotency key so retries never duplicate.

CREATE TABLE IF NOT EXISTS public.pvr_agent_configs (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT public.pvr_effective_uid(),
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'tested', 'published', 'superseded')),
    rules JSONB NOT NULL DEFAULT '{}'::jsonb,
    rules_hash TEXT NOT NULL DEFAULT '',
    change_note TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT 'Admin',
    test_result JSONB,
    tested_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    published_by TEXT,
    rolled_back_from INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pvr_agent_configs_version ON public.pvr_agent_configs(owner_id, agent_id, version);
CREATE INDEX IF NOT EXISTS idx_pvr_agent_configs_agent ON public.pvr_agent_configs(owner_id, agent_id, version DESC);

CREATE TABLE IF NOT EXISTS public.pvr_agent_pointer (
    owner_id UUID NOT NULL DEFAULT public.pvr_effective_uid(),
    agent_id TEXT NOT NULL,
    published_version INTEGER,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (owner_id, agent_id)
);

CREATE TABLE IF NOT EXISTS public.pvr_agent_runs (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT public.pvr_effective_uid(),
    agent_id TEXT NOT NULL,
    case_id TEXT,
    config_version INTEGER NOT NULL DEFAULT 0,
    config_source TEXT NOT NULL DEFAULT 'built_in',
    kind TEXT NOT NULL DEFAULT 'live' CHECK (kind IN ('live', 'test')),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'fallback', 'failed', 'blocked')),
    model TEXT,
    tool TEXT,
    error TEXT,
    precedent_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_agent_runs_agent ON public.pvr_agent_runs(owner_id, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pvr_notification_rules (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT public.pvr_effective_uid(),
    name TEXT NOT NULL,
    trigger_event TEXT NOT NULL,
    project_scope TEXT NOT NULL DEFAULT 'all',
    recipient_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
    channel TEXT NOT NULL DEFAULT 'email',
    template_subject TEXT NOT NULL DEFAULT '',
    template_body TEXT NOT NULL DEFAULT '',
    approval_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
    reminder_after_hours INTEGER,
    escalate_after_hours INTEGER,
    esignature_after_step INTEGER,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    enabled_by TEXT,
    enabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_notification_rules_owner ON public.pvr_notification_rules(owner_id);

CREATE TABLE IF NOT EXISTS public.pvr_notification_deliveries (
    id TEXT PRIMARY KEY,
    owner_id UUID NOT NULL DEFAULT public.pvr_effective_uid(),
    rule_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_ref TEXT NOT NULL,
    case_id TEXT,
    recipient_role TEXT NOT NULL,
    recipient_ref TEXT,
    channel TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('preview', 'test', 'live')),
    status TEXT NOT NULL CHECK (status IN ('previewed', 'test_recorded', 'sent', 'blocked', 'failed', 'unresolved_recipient')),
    detail TEXT NOT NULL DEFAULT '',
    rendered_subject TEXT NOT NULL DEFAULT '',
    rendered_body TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pvr_notification_deliveries_idem ON public.pvr_notification_deliveries(owner_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_pvr_notification_deliveries_rule ON public.pvr_notification_deliveries(owner_id, rule_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.pvr_admin_owner_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $func$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.owner_id := COALESCE(NEW.owner_id, public.pvr_effective_uid());
    ELSIF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
        RAISE EXCEPTION 'owner_id cannot be changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$func$;

DO $do$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['pvr_agent_configs', 'pvr_agent_pointer', 'pvr_agent_runs', 'pvr_notification_rules', 'pvr_notification_deliveries'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_guard', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.pvr_admin_owner_guard()', t || '_guard', t);
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())', t || '_owner_select', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())', t || '_owner_insert', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t || '_owner_update', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (owner_id = %L::uuid)', t || '_guest_select', t, '00000000-0000-0000-0000-000000000001');
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (owner_id = %L::uuid)', t || '_guest_insert', t, '00000000-0000-0000-0000-000000000001');
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', t || '_guest_update', t, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO anon', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO authenticated', t);
    END LOOP;
END
$do$;
-- No delete policies: versions, runs and deliveries are history.

NOTIFY pgrst, 'reload schema';

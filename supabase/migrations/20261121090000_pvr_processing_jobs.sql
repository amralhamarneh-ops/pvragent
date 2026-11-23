-- Durable background processing. Additive and idempotent. Drops nothing, deletes nothing.
--
-- Model
--   pvr_processing_jobs    one analysis run (case_id + run_id). Persistent state machine:
--                          queued | running | stopping | stopped | completed | partial | failed
--   pvr_processing_tasks   one row per (job, document, stage). Claimed by an independent worker with a lease.
--                          input_hash + config_version identify the exact inputs; a changed hash invalidates the checkpoint.
--   pvr_processing_events  append-only progress/geometry log (the UI polls it; execution never depends on the UI).
--   Results are stored on the task row (result jsonb + result_hash) and published exactly once, guarded by a
--   fencing token (lease_token) so a stale worker can never overwrite or duplicate a published result.
--
-- Security
--   * The browser/Next.js side acts as the signed-in user through RLS (owner_id = auth.uid(), guest = fixed uid).
--   * The worker has NO user session and NO service-role key. It calls the pvr_worker_* functions below, which are
--     SECURITY DEFINER and refuse to run unless the caller supplies the shared worker secret that was stored with
--     pvr_set_worker_secret(). Direct table access for the worker is not granted.

CREATE TABLE IF NOT EXISTS public.pvr_worker_config (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    secret_hash TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE public.pvr_worker_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pvr_worker_config FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.pvr_processing_jobs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    run_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'stopping', 'stopped', 'completed', 'partial', 'failed')),
    cancel_requested_at TIMESTAMPTZ,
    cancel_acknowledged_at TIMESTAMPTZ,
    config_version TEXT NOT NULL DEFAULT 'agents-1',
    source_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
    resumed_from TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (case_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_pvr_processing_jobs_case ON public.pvr_processing_jobs(case_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.pvr_processing_tasks (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES public.pvr_processing_jobs(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    doc_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    stage TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    config_version TEXT NOT NULL DEFAULT 'agents-1',
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'skipped', 'reused')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_token TEXT,
    lease_expires_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    worker_id TEXT,
    progress JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    result_hash TEXT,
    reused_from TEXT,
    error TEXT,
    source_url TEXT,
    source_url_expires_at TIMESTAMPTZ,
    source_kind TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (job_id, doc_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_pvr_processing_tasks_job ON public.pvr_processing_tasks(job_id);
CREATE INDEX IF NOT EXISTS idx_pvr_processing_tasks_claim ON public.pvr_processing_tasks(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_pvr_processing_tasks_reuse ON public.pvr_processing_tasks(case_id, doc_id, stage, input_hash, config_version, status);

CREATE TABLE IF NOT EXISTS public.pvr_processing_events (
    seq BIGSERIAL PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES public.pvr_processing_jobs(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL REFERENCES public.pvr_cases(id) ON DELETE CASCADE,
    owner_id UUID DEFAULT public.pvr_effective_uid(),
    task_id TEXT,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pvr_processing_events_job ON public.pvr_processing_events(job_id, seq);

-- Owner guards (same pattern as the other pvr_* child tables).
DROP TRIGGER IF EXISTS pvr_processing_jobs_owner_guard ON public.pvr_processing_jobs;
CREATE TRIGGER pvr_processing_jobs_owner_guard BEFORE INSERT ON public.pvr_processing_jobs
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();
DROP TRIGGER IF EXISTS pvr_processing_tasks_owner_guard ON public.pvr_processing_tasks;
CREATE TRIGGER pvr_processing_tasks_owner_guard BEFORE INSERT ON public.pvr_processing_tasks
FOR EACH ROW EXECUTE FUNCTION public.pvr_enforce_child_owner();

ALTER TABLE public.pvr_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_processing_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pvr_processing_events ENABLE ROW LEVEL SECURITY;

DO $do$
DECLARE
    guest CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['pvr_processing_jobs', 'pvr_processing_tasks', 'pvr_processing_events'] LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO anon', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO authenticated', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (owner_id = auth.uid())', t || '_owner_select', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_select', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (owner_id = %L::uuid)', t || '_guest_select', t, guest);
    END LOOP;
    -- Jobs and tasks may be inserted/updated by their owner (submit, stop, resume, retry). Events are written by the worker only.
    FOREACH t IN ARRAY ARRAY['pvr_processing_jobs', 'pvr_processing_tasks'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid())', t || '_owner_insert', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_owner_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t || '_owner_update', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_insert', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (owner_id = %L::uuid)', t || '_guest_insert', t, guest);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_update', t);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', t || '_guest_update', t, guest, guest);
    END LOOP;
END
$do$;

-- ---------------------------------------------------------------------------------------------------------
-- Worker authentication. Only a hash of the shared secret is stored. Set it once, as a database admin:
--   SELECT public.pvr_set_worker_secret('<the same value as WORKER_DB_SECRET on the worker>');
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pvr_set_worker_secret(p_secret TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
    IF p_secret IS NULL OR length(p_secret) < 24 THEN
        RAISE EXCEPTION 'The worker secret must be at least 24 characters' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.pvr_worker_config (id, secret_hash) VALUES (1, encode(extensions.digest(p_secret, 'sha256'), 'hex'))
    ON CONFLICT (id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, updated_at = CURRENT_TIMESTAMP;
END;
$func$;
REVOKE ALL ON FUNCTION public.pvr_set_worker_secret(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pvr_assert_worker(p_secret TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    h TEXT;
BEGIN
    SELECT secret_hash INTO h FROM public.pvr_worker_config WHERE id = 1 LIMIT 1;
    IF h IS NULL THEN
        RAISE EXCEPTION 'Worker secret is not configured in the database' USING ERRCODE = '42501';
    END IF;
    IF p_secret IS NULL OR encode(extensions.digest(p_secret, 'sha256'), 'hex') <> h THEN
        RAISE EXCEPTION 'Invalid worker secret' USING ERRCODE = '42501';
    END IF;
END;
$func$;
REVOKE ALL ON FUNCTION public.pvr_assert_worker(TEXT) FROM PUBLIC, anon, authenticated;

-- Claim the next runnable task. SKIP LOCKED means two workers can never receive the same task. A task whose lease
-- expired (worker crashed / restarted) is reclaimed here, which is the recovery path. Tasks of a job that has a
-- cancel request are acknowledged as cancelled instead of being started.
CREATE OR REPLACE FUNCTION public.pvr_worker_claim(p_secret TEXT, p_worker_id TEXT, p_lease_seconds INTEGER DEFAULT 60)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    t public.pvr_processing_tasks%ROWTYPE;
    j public.pvr_processing_jobs%ROWTYPE;
    tok TEXT := encode(extensions.gen_random_bytes(16), 'hex');
BEGIN
    PERFORM public.pvr_assert_worker(p_secret);
    LOOP
        SELECT k.* INTO t FROM public.pvr_processing_tasks k
        JOIN public.pvr_processing_jobs jj ON jj.id = k.job_id
        WHERE (k.status = 'queued' OR (k.status = 'running' AND k.lease_expires_at < now()))
          AND jj.state IN ('queued', 'running', 'stopping')
        ORDER BY k.created_at ASC
        LIMIT 1
        FOR UPDATE OF k SKIP LOCKED;
        IF NOT FOUND THEN RETURN NULL; END IF;

        SELECT * INTO j FROM public.pvr_processing_jobs WHERE id = t.job_id FOR UPDATE;
        IF j.cancel_requested_at IS NOT NULL OR j.state = 'stopping' THEN
            UPDATE public.pvr_processing_tasks SET status = 'cancelled', lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now(), error = 'Stopped before this task started.' WHERE id = t.id;
            PERFORM public.pvr_refresh_job(t.job_id);
            CONTINUE;
        END IF;
        IF t.attempts >= t.max_attempts THEN
            UPDATE public.pvr_processing_tasks SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, finished_at = now(), updated_at = now(), error = COALESCE(error, 'Worker lease expired and the retry limit was reached.') WHERE id = t.id;
            INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, task_id, kind, detail) VALUES (t.job_id, t.case_id, t.owner_id, t.id, 'task_failed', 'Retry limit reached after worker lease expiry.');
            PERFORM public.pvr_refresh_job(t.job_id);
            CONTINUE;
        END IF;

        UPDATE public.pvr_processing_tasks
        SET status = 'running', attempts = attempts + 1, lease_token = tok, worker_id = p_worker_id,
            lease_expires_at = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now(),
            started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = t.id;
        UPDATE public.pvr_processing_jobs SET state = 'running', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = t.job_id AND state = 'queued';
        INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, task_id, kind, detail)
        VALUES (t.job_id, t.case_id, t.owner_id, t.id, 'task_started', format('%s · %s (attempt %s)', t.file_name, t.stage, t.attempts + 1));
        RETURN jsonb_build_object('taskId', t.id, 'jobId', t.job_id, 'caseId', t.case_id, 'ownerId', t.owner_id, 'docId', t.doc_id,
            'fileName', t.file_name, 'stage', t.stage, 'inputHash', t.input_hash, 'configVersion', t.config_version,
            'attempt', t.attempts + 1, 'leaseToken', tok);
    END LOOP;
END;
$func$;

-- Heartbeat extends the lease and reports whether the worker should stop (cancel requested or lease lost).
CREATE OR REPLACE FUNCTION public.pvr_worker_heartbeat(p_secret TEXT, p_task_id TEXT, p_lease_token TEXT, p_lease_seconds INTEGER, p_progress JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    t public.pvr_processing_tasks%ROWTYPE;
    cancel BOOLEAN;
BEGIN
    PERFORM public.pvr_assert_worker(p_secret);
    SELECT * INTO t FROM public.pvr_processing_tasks WHERE id = p_task_id FOR UPDATE;
    IF NOT FOUND OR t.lease_token IS DISTINCT FROM p_lease_token OR t.status <> 'running' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'lease_lost', 'cancel', false);
    END IF;
    SELECT (cancel_requested_at IS NOT NULL) INTO cancel FROM public.pvr_processing_jobs WHERE id = t.job_id;
    UPDATE public.pvr_processing_tasks
    SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => p_lease_seconds), progress = COALESCE(p_progress, progress), updated_at = now()
    WHERE id = p_task_id;
    UPDATE public.pvr_processing_jobs SET updated_at = now() WHERE id = t.job_id;
    RETURN jsonb_build_object('ok', true, 'cancel', COALESCE(cancel, false));
END;
$func$;

CREATE OR REPLACE FUNCTION public.pvr_worker_event(p_secret TEXT, p_task_id TEXT, p_lease_token TEXT, p_kind TEXT, p_detail TEXT, p_payload JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    t public.pvr_processing_tasks%ROWTYPE;
    s BIGINT;
BEGIN
    PERFORM public.pvr_assert_worker(p_secret);
    SELECT * INTO t FROM public.pvr_processing_tasks WHERE id = p_task_id;
    IF NOT FOUND OR t.lease_token IS DISTINCT FROM p_lease_token THEN RETURN NULL; END IF;
    INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, task_id, kind, detail, payload)
    VALUES (t.job_id, t.case_id, t.owner_id, t.id, p_kind, COALESCE(p_detail, ''), p_payload) RETURNING seq INTO s;
    RETURN s;
END;
$func$;

-- Recompute the job state from its tasks. Stopping becomes stopped only when no task is still running (the cancel is
-- acknowledged by the worker, not assumed). Completed checkpoints are never touched.
CREATE OR REPLACE FUNCTION public.pvr_refresh_job(p_job_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    j public.pvr_processing_jobs%ROWTYPE;
    n_open INTEGER; n_run INTEGER; n_fail INTEGER; n_part INTEGER; n_canc INTEGER; n_all INTEGER;
BEGIN
    SELECT * INTO j FROM public.pvr_processing_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT count(*) FILTER (WHERE status IN ('queued', 'running')), count(*) FILTER (WHERE status = 'running'),
           count(*) FILTER (WHERE status = 'failed'), count(*) FILTER (WHERE status = 'partial'),
           count(*) FILTER (WHERE status = 'cancelled'), count(*)
    INTO n_open, n_run, n_fail, n_part, n_canc, n_all FROM public.pvr_processing_tasks WHERE job_id = p_job_id;

    IF j.cancel_requested_at IS NOT NULL THEN
        -- Queued tasks are cancelled immediately; running ones must acknowledge via complete/fail/release.
        UPDATE public.pvr_processing_tasks SET status = 'cancelled', finished_at = now(), updated_at = now(), error = 'Stopped before this task started.' WHERE job_id = p_job_id AND status = 'queued';
        SELECT count(*) FILTER (WHERE status = 'running') INTO n_run FROM public.pvr_processing_tasks WHERE job_id = p_job_id;
        IF n_run = 0 AND j.state <> 'stopped' THEN
            UPDATE public.pvr_processing_jobs SET state = 'stopped', cancel_acknowledged_at = now(), finished_at = now(), updated_at = now() WHERE id = p_job_id;
            INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, kind, detail) VALUES (j.id, j.case_id, j.owner_id, 'job_stopped', 'Cancellation acknowledged. Completed checkpoints were kept.');
        END IF;
        RETURN;
    END IF;
    IF n_open > 0 THEN RETURN; END IF;
    IF n_all = 0 THEN RETURN; END IF;
    UPDATE public.pvr_processing_jobs
    SET state = CASE WHEN n_fail > 0 THEN 'failed' WHEN n_part > 0 THEN 'partial' ELSE 'completed' END, finished_at = now(), updated_at = now()
    WHERE id = p_job_id AND state IN ('queued', 'running');
END;
$func$;
REVOKE ALL ON FUNCTION public.pvr_refresh_job(TEXT) FROM PUBLIC, anon, authenticated;

-- Publish a result exactly once. The fencing token must match the current lease; a stale worker (lease reclaimed
-- after a restart) is refused, and a task that is already completed ignores a second publish.
CREATE OR REPLACE FUNCTION public.pvr_worker_complete(p_secret TEXT, p_task_id TEXT, p_lease_token TEXT, p_status TEXT, p_result JSONB, p_result_hash TEXT, p_error TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    t public.pvr_processing_tasks%ROWTYPE;
    cancel BOOLEAN;
BEGIN
    PERFORM public.pvr_assert_worker(p_secret);
    IF p_status NOT IN ('completed', 'partial', 'failed') THEN RAISE EXCEPTION 'Invalid status %', p_status USING ERRCODE = '22023'; END IF;
    SELECT * INTO t FROM public.pvr_processing_tasks WHERE id = p_task_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('published', false, 'reason', 'not_found'); END IF;
    IF t.status IN ('completed', 'partial', 'reused') THEN RETURN jsonb_build_object('published', false, 'reason', 'already_published'); END IF;
    IF t.lease_token IS DISTINCT FROM p_lease_token OR t.status <> 'running' THEN RETURN jsonb_build_object('published', false, 'reason', 'stale_lease'); END IF;
    SELECT (cancel_requested_at IS NOT NULL) INTO cancel FROM public.pvr_processing_jobs WHERE id = t.job_id;
    IF COALESCE(cancel, false) AND p_status <> 'failed' THEN
        -- Finished before the cancel could take effect: keep the completed checkpoint (it is valid work).
        NULL;
    END IF;
    UPDATE public.pvr_processing_tasks
    SET status = p_status, result = p_result, result_hash = p_result_hash, error = p_error, lease_token = NULL, lease_expires_at = NULL,
        finished_at = now(), updated_at = now()
    WHERE id = p_task_id;
    INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, task_id, kind, detail)
    VALUES (t.job_id, t.case_id, t.owner_id, t.id, CASE WHEN p_status = 'failed' THEN 'task_failed' ELSE 'task_done' END,
            format('%s · %s: %s', t.file_name, t.stage, p_status));
    PERFORM public.pvr_refresh_job(t.job_id);
    RETURN jsonb_build_object('published', true);
END;
$func$;

-- Worker acknowledges a cancel (or hands a task back after a transient failure that should be retried).
CREATE OR REPLACE FUNCTION public.pvr_worker_release(p_secret TEXT, p_task_id TEXT, p_lease_token TEXT, p_reason TEXT, p_requeue BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    t public.pvr_processing_tasks%ROWTYPE;
BEGIN
    PERFORM public.pvr_assert_worker(p_secret);
    SELECT * INTO t FROM public.pvr_processing_tasks WHERE id = p_task_id FOR UPDATE;
    IF NOT FOUND OR t.lease_token IS DISTINCT FROM p_lease_token OR t.status <> 'running' THEN RETURN jsonb_build_object('released', false); END IF;
    UPDATE public.pvr_processing_tasks
    SET status = CASE WHEN p_requeue AND t.attempts < t.max_attempts THEN 'queued' WHEN p_requeue THEN 'failed' ELSE 'cancelled' END,
        lease_token = NULL, lease_expires_at = NULL, finished_at = CASE WHEN p_requeue AND t.attempts < t.max_attempts THEN NULL ELSE now() END,
        error = p_reason, updated_at = now()
    WHERE id = p_task_id;
    INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, task_id, kind, detail)
    VALUES (t.job_id, t.case_id, t.owner_id, t.id, CASE WHEN p_requeue THEN 'task_retry' ELSE 'task_cancelled' END, COALESCE(p_reason, ''));
    PERFORM public.pvr_refresh_job(t.job_id);
    RETURN jsonb_build_object('released', true);
END;
$func$;

-- Owner-callable: request a stop. The job moves to 'stopping' and only becomes 'stopped' when the worker acknowledges.
CREATE OR REPLACE FUNCTION public.pvr_request_stop(p_case_id TEXT, p_job_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $func$
DECLARE
    j public.pvr_processing_jobs%ROWTYPE;
BEGIN
    SELECT * INTO j FROM public.pvr_processing_jobs WHERE id = p_job_id AND case_id = p_case_id AND owner_id = public.pvr_effective_uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Job not found for this case' USING ERRCODE = '42501'; END IF;
    IF j.state IN ('completed', 'partial', 'failed', 'stopped') THEN RETURN jsonb_build_object('state', j.state, 'changed', false); END IF;
    UPDATE public.pvr_processing_jobs SET state = 'stopping', cancel_requested_at = COALESCE(cancel_requested_at, now()), updated_at = now() WHERE id = p_job_id;
    UPDATE public.pvr_processing_tasks SET status = 'cancelled', finished_at = now(), updated_at = now(), error = 'Stopped before this task started.' WHERE job_id = p_job_id AND status = 'queued';
    INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, kind, detail) VALUES (j.id, j.case_id, j.owner_id, 'stop_requested', 'Stop requested. Waiting for the worker to acknowledge.');
    -- No running task: acknowledge at once (nothing is executing).
    IF NOT EXISTS (SELECT 1 FROM public.pvr_processing_tasks WHERE job_id = p_job_id AND status = 'running') THEN
        UPDATE public.pvr_processing_jobs SET state = 'stopped', cancel_acknowledged_at = now(), finished_at = now(), updated_at = now() WHERE id = p_job_id;
        INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, kind, detail) VALUES (j.id, j.case_id, j.owner_id, 'job_stopped', 'No task was executing; stopped immediately. Completed checkpoints were kept.');
        RETURN jsonb_build_object('state', 'stopped', 'changed', true);
    END IF;
    RETURN jsonb_build_object('state', 'stopping', 'changed', true);
END;
$func$;

-- Owner-callable: resume or retry. Creates a NEW job (the interrupted one stays as a separate record) and reuses every
-- compatible completed task: same doc, stage, input_hash and config_version. Changed inputs get fresh queued tasks.
-- p_mode = 'resume' reuses everything compatible; 'retry' reuses everything compatible AND re-queues failed tasks only.
CREATE OR REPLACE FUNCTION public.pvr_resume_job(p_case_id TEXT, p_job_id TEXT, p_new_job_id TEXT, p_new_run_id TEXT, p_current JSONB, p_config_version TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $func$
DECLARE
    old public.pvr_processing_jobs%ROWTYPE;
    k public.pvr_processing_tasks%ROWTYPE;
    cur_hash TEXT; reused INTEGER := 0; queued INTEGER := 0; invalid INTEGER := 0;
    prior public.pvr_processing_tasks%ROWTYPE;
    new_task_id TEXT;
BEGIN
    SELECT * INTO old FROM public.pvr_processing_jobs WHERE id = p_job_id AND case_id = p_case_id AND owner_id = public.pvr_effective_uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Job not found for this case' USING ERRCODE = '42501'; END IF;
    IF old.state IN ('queued', 'running', 'stopping') THEN RAISE EXCEPTION 'The job is still active; stop it first or wait for it to finish' USING ERRCODE = '55000'; END IF;
    INSERT INTO public.pvr_processing_jobs (id, case_id, run_id, state, config_version, source_hashes, resumed_from)
    VALUES (p_new_job_id, p_case_id, p_new_run_id, 'queued', p_config_version, COALESCE(p_current, '{}'::jsonb), p_job_id);
    FOR k IN SELECT * FROM public.pvr_processing_tasks WHERE job_id = p_job_id ORDER BY created_at LOOP
        cur_hash := p_current ->> k.doc_id;
        new_task_id := p_new_job_id || ':' || k.doc_id || ':' || k.stage;
        IF cur_hash IS NULL THEN
            -- The document is no longer part of the run.
            invalid := invalid + 1;
            CONTINUE;
        END IF;
        -- Best compatible completed work for this exact document/stage/hash/config (from this or any earlier job of the case).
        SELECT * INTO prior FROM public.pvr_processing_tasks
        WHERE case_id = p_case_id AND doc_id = k.doc_id AND stage = k.stage AND input_hash = cur_hash AND config_version = p_config_version
          AND status IN ('completed', 'partial', 'reused') AND result IS NOT NULL
        ORDER BY finished_at DESC NULLS LAST LIMIT 1;
        IF FOUND AND prior.status <> 'partial' THEN
            INSERT INTO public.pvr_processing_tasks (id, job_id, case_id, doc_id, file_name, stage, input_hash, config_version, status, result, result_hash, reused_from, finished_at, progress)
            VALUES (new_task_id, p_new_job_id, p_case_id, k.doc_id, k.file_name, k.stage, cur_hash, p_config_version, 'reused', prior.result, prior.result_hash, prior.id, now(), jsonb_build_object('reused', true));
            reused := reused + 1;
        ELSE
            INSERT INTO public.pvr_processing_tasks (id, job_id, case_id, doc_id, file_name, stage, input_hash, config_version, status)
            VALUES (new_task_id, p_new_job_id, p_case_id, k.doc_id, k.file_name, k.stage, cur_hash, p_config_version, 'queued');
            queued := queued + 1;
            IF k.status IN ('completed', 'partial') AND k.input_hash <> cur_hash THEN invalid := invalid + 1; END IF;
        END IF;
    END LOOP;
    INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, kind, detail)
    VALUES (p_new_job_id, p_case_id, public.pvr_effective_uid(), 'job_resumed', format('Resumed from %s: %s reused, %s to run, %s invalidated by changed or removed input.', p_job_id, reused, queued, invalid));
    IF queued = 0 THEN PERFORM public.pvr_refresh_job_owner(p_new_job_id); END IF;
    RETURN jsonb_build_object('jobId', p_new_job_id, 'reused', reused, 'queued', queued, 'invalidated', invalid);
END;
$func$;

-- Owner-context refresh used when a resumed job has nothing left to run.
CREATE OR REPLACE FUNCTION public.pvr_refresh_job_owner(p_job_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $func$
BEGIN
    UPDATE public.pvr_processing_jobs
    SET state = 'completed', started_at = COALESCE(started_at, now()), finished_at = now(), updated_at = now()
    WHERE id = p_job_id AND owner_id = public.pvr_effective_uid() AND state = 'queued'
      AND NOT EXISTS (SELECT 1 FROM public.pvr_processing_tasks WHERE job_id = p_job_id AND status IN ('queued', 'running'));
END;
$func$;

-- Owner-callable: re-queue only failed (or cancelled) tasks of a finished job, keeping completed results. Same job id.
CREATE OR REPLACE FUNCTION public.pvr_retry_failed(p_case_id TEXT, p_job_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $func$
DECLARE
    j public.pvr_processing_jobs%ROWTYPE;
    n INTEGER;
BEGIN
    SELECT * INTO j FROM public.pvr_processing_jobs WHERE id = p_job_id AND case_id = p_case_id AND owner_id = public.pvr_effective_uid() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Job not found for this case' USING ERRCODE = '42501'; END IF;
    IF j.state IN ('queued', 'running', 'stopping') THEN RAISE EXCEPTION 'The job is still active' USING ERRCODE = '55000'; END IF;
    UPDATE public.pvr_processing_tasks
    SET status = 'queued', attempts = 0, error = NULL, lease_token = NULL, lease_expires_at = NULL, finished_at = NULL, updated_at = now()
    WHERE job_id = p_job_id AND status = 'failed';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RETURN jsonb_build_object('requeued', 0, 'state', j.state); END IF;
    UPDATE public.pvr_processing_jobs SET state = 'queued', finished_at = NULL, cancel_requested_at = NULL, cancel_acknowledged_at = NULL, last_error = NULL, updated_at = now() WHERE id = p_job_id;
    INSERT INTO public.pvr_processing_events (job_id, case_id, owner_id, kind, detail) VALUES (j.id, j.case_id, j.owner_id, 'job_retry', format('%s failed task(s) re-queued; completed work kept.', n));
    RETURN jsonb_build_object('requeued', n, 'state', 'queued');
END;
$func$;

-- Worker-facing document access: a short, owner-scoped read of the registry row the task refers to.
CREATE OR REPLACE FUNCTION public.pvr_worker_document(p_secret TEXT, p_task_id TEXT, p_lease_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
DECLARE
    t public.pvr_processing_tasks%ROWTYPE;
    d public.pvr_case_documents%ROWTYPE;
BEGIN
    PERFORM public.pvr_assert_worker(p_secret);
    SELECT * INTO t FROM public.pvr_processing_tasks WHERE id = p_task_id;
    IF NOT FOUND OR t.lease_token IS DISTINCT FROM p_lease_token THEN RETURN NULL; END IF;
    SELECT * INTO d FROM public.pvr_case_documents WHERE id = t.doc_id AND case_id = t.case_id AND owner_id = t.owner_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('name', d.file_name, 'sha256', d.sha256, 'stored', d.stored, 'sourceUrl', t.source_url, 'sourceUrlExpiresAt', t.source_url_expires_at, 'inputHash', t.input_hash);
END;
$func$;

-- Owner-callable: attach a short-lived signed download URL (created by the app server with the user's own session) to the
-- queued tasks of a job. The worker needs no storage credential: it can read only this one object until the URL expires.
CREATE OR REPLACE FUNCTION public.pvr_attach_sources(p_case_id TEXT, p_job_id TEXT, p_sources JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $func$
DECLARE
    n INTEGER;
BEGIN
    UPDATE public.pvr_processing_tasks k
    SET source_url = s.value ->> 'url', source_url_expires_at = (s.value ->> 'expiresAt')::timestamptz, source_kind = s.value ->> 'kind', updated_at = now()
    FROM jsonb_each(p_sources) s
    WHERE k.job_id = p_job_id AND k.case_id = p_case_id AND k.owner_id = public.pvr_effective_uid() AND k.doc_id = s.key AND k.status IN ('queued', 'running');
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$func$;
GRANT EXECUTE ON FUNCTION public.pvr_attach_sources(text, text, jsonb) TO anon, authenticated;

DO $do$
DECLARE
    f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'pvr_worker_claim(text,text,integer)', 'pvr_worker_heartbeat(text,text,text,integer,jsonb)', 'pvr_worker_event(text,text,text,text,text,jsonb)',
        'pvr_worker_complete(text,text,text,text,jsonb,text,text)', 'pvr_worker_release(text,text,text,text,boolean)', 'pvr_worker_document(text,text,text)'
    ] LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO anon, authenticated', f);
    END LOOP;
    GRANT EXECUTE ON FUNCTION public.pvr_request_stop(text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.pvr_resume_job(text, text, text, text, jsonb, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.pvr_retry_failed(text, text) TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.pvr_refresh_job_owner(text) TO anon, authenticated;
END
$do$;

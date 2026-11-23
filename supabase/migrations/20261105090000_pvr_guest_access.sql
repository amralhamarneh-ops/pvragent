-- Sign-in is not required for now. The anon role acts as one shared guest user.
-- Additive and idempotent. Existing authenticated-user policies stay in place.

-- 1. Owner resolution: the signed-in user, or the shared guest when there is no session.
CREATE OR REPLACE FUNCTION public.pvr_effective_uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $func$
    SELECT COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000001'::uuid);
$func$;

-- 2. Child-row guard uses the effective uid.
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

-- 3. Defaults fall back to the guest.
ALTER TABLE public.pvr_cases ALTER COLUMN owner_id SET DEFAULT public.pvr_effective_uid();
DO $do$
BEGIN
    IF to_regclass('public.pvr_boq_imports') IS NOT NULL THEN
        ALTER TABLE public.pvr_boq_imports ALTER COLUMN owner_id SET DEFAULT public.pvr_effective_uid();
    END IF;
    IF to_regclass('public.pvr_boq_rows') IS NOT NULL THEN
        ALTER TABLE public.pvr_boq_rows ALTER COLUMN owner_id SET DEFAULT public.pvr_effective_uid();
    END IF;
    IF to_regclass('public.pvr_calculations') IS NOT NULL THEN
        ALTER TABLE public.pvr_calculations ALTER COLUMN owner_id SET DEFAULT public.pvr_effective_uid();
    END IF;
    IF to_regclass('public.pvr_case_documents') IS NOT NULL THEN
        ALTER TABLE public.pvr_case_documents ALTER COLUMN owner_id SET DEFAULT public.pvr_effective_uid();
    END IF;
    IF to_regclass('public.pvr_case_evidence') IS NOT NULL THEN
        ALTER TABLE public.pvr_case_evidence ALTER COLUMN owner_id SET DEFAULT public.pvr_effective_uid();
    END IF;
END
$do$;

-- 4. Table grants and policies for the anon role, limited to rows owned by the guest.
DO $do$
DECLARE
    t TEXT;
    guest CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
BEGIN
    FOREACH t IN ARRAY ARRAY['pvr_cases','pvr_boq_imports','pvr_boq_rows','pvr_calculations','pvr_case_documents','pvr_case_evidence']
    LOOP
        IF to_regclass('public.' || t) IS NOT NULL THEN
            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon', t);
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_select', t);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO anon USING (owner_id = %L::uuid)', t || '_guest_select', t, guest);
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_insert', t);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO anon WITH CHECK (owner_id = %L::uuid)', t || '_guest_insert', t, guest);
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_update', t);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO anon USING (owner_id = %L::uuid) WITH CHECK (owner_id = %L::uuid)', t || '_guest_update', t, guest, guest);
            EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_guest_delete', t);
            EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO anon USING (owner_id = %L::uuid)', t || '_guest_delete', t, guest);
        END IF;
    END LOOP;
END
$do$;

-- 5. Private bucket access for the guest's own folder.
DROP POLICY IF EXISTS "pvr_boq_files_guest_select" ON storage.objects;
CREATE POLICY "pvr_boq_files_guest_select" ON storage.objects FOR SELECT TO anon
USING (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000001');
DROP POLICY IF EXISTS "pvr_boq_files_guest_insert" ON storage.objects;
CREATE POLICY "pvr_boq_files_guest_insert" ON storage.objects FOR INSERT TO anon
WITH CHECK (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000001');
DROP POLICY IF EXISTS "pvr_boq_files_guest_update" ON storage.objects;
CREATE POLICY "pvr_boq_files_guest_update" ON storage.objects FOR UPDATE TO anon
USING (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000001')
WITH CHECK (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000001');
DROP POLICY IF EXISTS "pvr_boq_files_guest_delete" ON storage.objects;
CREATE POLICY "pvr_boq_files_guest_delete" ON storage.objects FOR DELETE TO anon
USING (bucket_id = 'pvr-boq-files' AND (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000001');

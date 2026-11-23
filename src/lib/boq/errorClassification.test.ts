import { describe, expect, it } from 'vitest';
import { classifyRestFailure, explainDiagnostic, resourceOf, sanitise, failureResponse, toStorageError, AccessDeniedError } from './supabaseStore';

const pg = (code: string, message: string, extra: Record<string, string> = {}) => JSON.stringify({ code, message, ...extra });

describe('structured storage error classification', () => {
  it('a missing import table names only that table', () => {
    const d = classifyRestFailure('GET pvr_boq_imports', 'pvr_boq_imports?case_id=eq.x&select=*', 404, pg('PGRST205', "Could not find the table 'public.pvr_boq_imports' in the schema cache", { hint: "Perhaps you meant 'public.pvr_cases'" }));
    expect(d.code).toBe('table_missing');
    expect(d.resource).toBe('pvr_boq_imports');
    const ex = explainDiagnostic(d);
    expect(ex.message).toContain('pvr_boq_imports');
    expect(ex.message).not.toMatch(/pvr_cases, pvr_boq_imports and pvr_boq_rows/);
    expect(ex.message).not.toMatch(/all three/i);
  });

  it('a missing column on an existing table is a column problem, not missing tables', () => {
    const d = classifyRestFailure('GET pvr_cases', 'pvr_cases?select=*', 400, pg('42703', 'column pvr_cases.owner_id does not exist'));
    expect(d.code).toBe('column_missing');
    expect(explainDiagnostic(d).message).not.toMatch(/does not exist or is not visible/);
    expect(explainDiagnostic(d).message).toContain('pvr_cases');
  });

  it('PGRST204 (unknown column in a write) is a column problem', () => {
    expect(classifyRestFailure('POST pvr_case_documents', 'pvr_case_documents', 400, pg('PGRST204', "Could not find the 'subrole' column")).code).toBe('column_missing');
  });

  it('a bare 404 with no database code is an endpoint or environment problem, not a missing table', () => {
    const d = classifyRestFailure('GET pvr_cases', 'pvr_cases?select=*', 404, '{"message":"requested path is invalid"}');
    expect(d.code).toBe('endpoint_not_found');
    expect(explainDiagnostic(d).nextAction).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it('a non-JSON 404 body is also an endpoint problem', () => {
    expect(classifyRestFailure('GET x', 'x', 404, '<html>Not Found</html>').code).toBe('endpoint_not_found');
  });

  it('row-level security and 401/403 stay permission failures', () => {
    expect(classifyRestFailure('POST t', 't', 403, pg('42501', 'new row violates row-level security policy for table "t"')).code).toBe('permission_denied');
    expect(classifyRestFailure('GET t', 't', 401, pg('PGRST301', 'JWT expired')).code).toBe('permission_denied');
  });

  it('5xx is a service failure', () => {
    expect(classifyRestFailure('GET t', 't', 503, 'upstream').code).toBe('service_error');
  });

  it('a schema exposure problem is a schema-cache issue', () => {
    expect(classifyRestFailure('GET t', 't', 406, pg('PGRST106', 'The schema must be one of the following: api')).code).toBe('schema_cache');
  });

  it('a check violation is not misreported as missing schema', () => {
    expect(classifyRestFailure('PATCH pvr_cases', 'pvr_cases?id=eq.1', 400, pg('23514', 'selected_import_id must be a confirmed import')).code).toBe('rejected');
  });

  it('keeps the legacy blocker for compatibility and carries the diagnostic through the API body', () => {
    const d = classifyRestFailure('GET pvr_boq_imports', 'pvr_boq_imports', 404, pg('PGRST205', 'missing'));
    const e = toStorageError(d);
    expect(e.kind).toBe('tables_missing');
    const f = failureResponse(e);
    expect(f.status).toBe(503);
    expect((f.body.diagnostic as { resource: string }).resource).toBe('pvr_boq_imports');
    expect((f.body.diagnostic as { nextAction: string }).nextAction).toMatch(/migration/);
  });

  it('permission failures keep their 403 status and are not turned into storage-unavailable', () => {
    const f = failureResponse(new AccessDeniedError(403, 'nope'));
    expect(f.status).toBe(403);
    expect(f.body.blocker).toBe('forbidden');
  });

  it('case-not-found stays a 404 with the not_found blocker', () => {
    const f = failureResponse(new AccessDeniedError(404, 'Case x was not found.'));
    expect(f.status).toBe(404);
    expect(f.body.blocker).toBe('not_found');
  });

  it('extracts the resource from a request path', () => {
    expect(resourceOf('pvr_boq_rows?import_id=eq.1&select=*')).toBe('pvr_boq_rows');
  });

  it('removes tokens, credentials and email addresses from messages', () => {
    const s = sanitise('apikey abc123 failed for jane.doe@example.com with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij');
    expect(s).not.toMatch(/abc123/);
    expect(s).not.toMatch(/jane\.doe@example\.com/);
    expect(s).not.toMatch(/eyJhbGci/);
  });
});

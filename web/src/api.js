/**
 * API client + auth.
 *
 * Talks to Supabase's REST token endpoint directly rather than pulling in
 * the JS SDK — one less dependency in a bundle that already carries three.js.
 */
let CFG = null;
let TOKEN = null;
let USER = null;

export async function loadConfig() {
  if (CFG) return CFG;
  const r = await fetch('/api/v1/config');
  CFG = (await r.json()).data;
  return CFG;
}

export function currentUser() { return USER; }
export function isAuthed() { return Boolean(TOKEN); }

export async function signIn(email, password) {
  const cfg = await loadConfig();
  const r = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey },
    body: JSON.stringify({ email: email.trim(), password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.msg || 'Invalid email or password');

  TOKEN = j.access_token;
  const payload = JSON.parse(
    atob(TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
  );
  if (!payload.app_role) {
    TOKEN = null;
    // An auth user with no staff profile. Never legitimate here — accounts
    // are admin-provisioned only.
    throw new Error('This account has no staff profile assigned.');
  }
  USER = {
    id: payload.sub,
    role: payload.app_role,
    email: j.user?.email ?? email,
    facilityId: payload.facility_id ?? null,
    districtId: payload.district_id ?? null,
  };
  return USER;
}

export function signOut() { TOKEN = null; USER = null; }

const listeners = new Set();
/** Subscribe to API activity for the on-screen log. */
export function onActivity(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e) { listeners.forEach((fn) => fn(e)); }

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (TOKEN) opts.headers.Authorization = `Bearer ${TOKEN}`;
  if (form) opts.body = form;
  else if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const started = Date.now();
  const r = await fetch(`/api/v1${path}`, opts);
  const j = await r.json().catch(() => ({}));
  const ms = Date.now() - started;

  emit({ method, path, status: r.status, ms, ok: r.ok });

  if (!r.ok) {
    const err = new Error(j.error?.message || `Request failed (${r.status})`);
    err.status = r.status;
    err.code = j.error?.code;
    err.details = j.error?.details;
    throw err;
  }
  return j.data;
}

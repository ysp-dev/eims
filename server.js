const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'employees.json');
const AUTH_FILE = path.join(ROOT, 'data', 'auth.json');
const EVAL_FILE = path.join(ROOT, 'data', 'evaluations.json');
const PORT = Number(process.env.PORT || 7000);
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUTH_FAILS = 5;
const AUTH_LOCK_MS = 30 * 1000;
const PASSWORD_RULE = /^.{4,}$/; // 내부망용: 4자 이상이면 어떤 문자든 허용
const SECURE_COOKIE = process.env.EIMS_SECURE === '1';
const COOKIE_FLAGS = `HttpOnly; SameSite=Lax; Path=/${SECURE_COOKIE ? '; Secure' : ''}`;
let PASSWORD_HASH = resolvePasswordHash();

const sessions = new Map();
const authFailures = new Map();

function parsePasswordHash(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.iterations && parsed.salt && parsed.hash && parsed.digest) return parsed;
  } catch (_) {}
  return null;
}

// 영문 + 숫자 + 기호를 포함하는 임시 비밀번호 생성 (PASSWORD_RULE 충족 보장)
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const symbol = '!@#$%^&*';
  const pick = set => set[crypto.randomInt(set.length)];
  return crypto.randomBytes(9).toString('base64url') + pick(upper) + pick(digit) + pick(symbol);
}

// 평문 비밀번호 → PBKDF2-SHA256 해시 레코드 (salt/hash는 base64로 직렬화)
function hashPassword(password) {
  const iterations = 310000;
  const digest = 'sha256';
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, digest);
  return { iterations, salt: salt.toString('base64'), hash: hash.toString('base64'), digest };
}

// 저장된 비밀번호 해시 파일 읽기 (없거나 손상 시 null)
function readStoredPasswordHash() {
  try {
    return parsePasswordHash(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

// 변경된 비밀번호 해시를 파일에 영구 저장 (원자적 교체 + 소유자만 접근)
function persistPasswordHash(hashObj) {
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(hashObj)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE);
}

// 런타임에 비밀번호를 변경하고 즉시 영구 저장 (재기동 후에도 유지)
function setPassword(password) {
  const next = hashPassword(password);
  persistPasswordHash(next);
  PASSWORD_HASH = next;
}

// 비밀번호 해시 결정 우선순위:
//   1) 운영 중 변경되어 저장된 해시 파일(data/auth.json) — 사용자가 마지막으로 설정한 값
//   2) EIMS_PASSWORD_HASH_JSON 환경변수로 고정한 해시
//   3) EIMS_PASSWORD 평문 환경변수
//   4) 없으면 1회용 임시 비밀번호를 생성해 콘솔에 출력
// (소스코드에 비밀번호/해시를 절대 하드코딩하지 않는다)
function resolvePasswordHash() {
  const stored = readStoredPasswordHash();
  if (stored) return stored;

  const fromJson = parsePasswordHash(process.env.EIMS_PASSWORD_HASH_JSON);
  if (fromJson) return fromJson;

  let password = process.env.EIMS_PASSWORD;
  const generated = !password;
  if (generated) password = generatePassword();

  const result = hashPassword(password);
  if (generated) {
    console.log('────────────────────────────────────────────');
    console.log('  EIMS 임시 접속 비밀번호 (이번 기동에서만 유효):');
    console.log(`     ${password}`);
    console.log('  영구 설정: EIMS_PASSWORD 또는 EIMS_PASSWORD_HASH_JSON 환경변수 사용');
    console.log('  (앱에서 비밀번호 변경 시 data/auth.json 에 저장되어 재기동 후에도 유지)');
    console.log('────────────────────────────────────────────');
  }
  return result;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
    ...headers,
  });
  res.end(payload);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error('요청 데이터가 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error('JSON 형식이 올바르지 않습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const idx = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, idx).trim()), decodeURIComponent(part.slice(idx + 1).trim())];
  }));
}

function getClientKey(req) {
  return req.socket.remoteAddress || 'local';
}

// CSRF 방어: 상태 변경 요청(POST/PUT/DELETE)은 동일 출처에서만 허용
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 동일출처 요청에서 Origin이 생략되는 경우 허용
  try {
    return new URL(origin).host === (req.headers.host || '');
  } catch (_) {
    return false;
  }
}

function verifyPassword(password) {
  const salt = Buffer.from(PASSWORD_HASH.salt, 'base64');
  const expected = Buffer.from(PASSWORD_HASH.hash, 'base64');
  const actual = crypto.pbkdf2Sync(password, salt, PASSWORD_HASH.iterations, expected.length, PASSWORD_HASH.digest);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createSession(res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(token, { createdAt: now, lastSeen: now });
  res.setHeader('Set-Cookie', `eims_session=${token}; ${COOKIE_FLAGS}`);
}

function clearSession(req, res) {
  const token = parseCookies(req).eims_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `eims_session=; ${COOKIE_FLAGS}; Max-Age=0`);
}

function requireSession(req, res) {
  const token = parseCookies(req).eims_session;
  const session = token && sessions.get(token);
  const now = Date.now();
  if (!session || now - session.lastSeen > SESSION_TTL_MS) {
    if (token) sessions.delete(token);
    send(res, 401, { error: '인증이 필요합니다.' });
    return false;
  }
  session.lastSeen = now;
  return true;
}

function loadEmployees() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function saveEmployees(employees) {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(employees, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

// ── 인사평가(평가하기) 저장소 ──
// { ratios: {S,A,G,C,D}, evals: { [직원번호]: { [평가기간]: 등급 } }, mult: { [직원번호]: 배수횟수 }, confirmed: { [평가기간]: true } }
const EVAL_GRADE_KEYS = ['S', 'A', 'G', 'C', 'D'];
const EVAL_PERIOD_KEYS = new Set(['2025-H1', '2025-H2', '2026-H1', '2026-H2', '2027-H1', '2027-H2']);

function emptyEvaluations() {
  return { ratios: { S: 0, A: 0, G: 0, C: 0, D: 0 }, evals: {}, mult: {}, awards: {}, comments: {}, confirmed: {} };
}

// 외부 입력(파일/요청)을 신뢰 가능한 형태로 정규화: 허용된 등급/기간만, 비율은 0 이상 소수 1자리
function normalizeEvaluations(input) {
  const ratios = {};
  for (const g of EVAL_GRADE_KEYS) {
    const n = Number(input?.ratios?.[g]);
    ratios[g] = Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0;
  }
  const evals = {};
  const src = input?.evals && typeof input.evals === 'object' ? input.evals : {};
  for (const [empNo, periods] of Object.entries(src)) {
    if (!periods || typeof periods !== 'object') continue;
    const rec = {};
    for (const [p, g] of Object.entries(periods)) {
      if (EVAL_PERIOD_KEYS.has(p) && EVAL_GRADE_KEYS.includes(g)) rec[p] = g;
    }
    if (Object.keys(rec).length) evals[String(empNo)] = rec;
  }
  // 배수횟수: 직원별 한 자리 숫자(0~9)만 허용
  const mult = {};
  const mSrc = input?.mult && typeof input.mult === 'object' ? input.mult : {};
  for (const [empNo, v] of Object.entries(mSrc)) {
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n) && n >= 0 && n <= 9) mult[String(empNo)] = n;
  }
  // (현직급)표창갯수: 직원별 정수 0~99
  const awards = {};
  const aSrc = input?.awards && typeof input.awards === 'object' ? input.awards : {};
  for (const [empNo, v] of Object.entries(aSrc)) {
    const n = Math.trunc(Number(v));
    if (Number.isFinite(n) && n >= 0 && n <= 99) awards[String(empNo)] = n;
  }
  // 종합평가의견: 직원별/기간별 자유 텍스트 (허용 기간만, 4000자 이내, 빈 값은 버림)
  const comments = {};
  const cmSrc = input?.comments && typeof input.comments === 'object' ? input.comments : {};
  for (const [empNo, periods] of Object.entries(cmSrc)) {
    if (!periods || typeof periods !== 'object') continue;
    const rec = {};
    for (const [p, t] of Object.entries(periods)) {
      if (!EVAL_PERIOD_KEYS.has(p)) continue;
      const text = String(t ?? '').slice(0, 4000).trim();
      if (text) rec[p] = text;
    }
    if (Object.keys(rec).length) comments[String(empNo)] = rec;
  }
  // 최종 확정된 평가기간 (해당 기간은 수정 잠금)
  const confirmed = {};
  const cSrc = input?.confirmed && typeof input.confirmed === 'object' ? input.confirmed : {};
  for (const [p, v] of Object.entries(cSrc)) {
    if (EVAL_PERIOD_KEYS.has(p) && v) confirmed[p] = true;
  }
  return { ratios, evals, mult, awards, comments, confirmed };
}

function loadEvaluations() {
  try {
    return normalizeEvaluations(JSON.parse(fs.readFileSync(EVAL_FILE, 'utf8')));
  } catch (_) {
    return emptyEvaluations();
  }
}

function saveEvaluations(data) {
  const tmp = `${EVAL_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, EVAL_FILE);
}

function normalizeEmployee(input, fallback = {}) {
  return {
    ...fallback,
    no: Number(input.no || fallback.no || 0),
    dept: String(input.dept || '').trim(),
    team: String(input.team || '').trim(),
    name: String(input.name || '').trim(),
    empNo: String(input.empNo || '').trim(),
    pos: String(input.pos || '').trim(),
    grade: String(input.grade || '').trim(),
    title: String(input.title || '').trim(),
    joinDate: String(input.joinDate || '').trim(),
    birthYear: Number(input.birthYear || 0),
    birth: String(input.birth || '').trim(),
    gender: String(input.gender || '').trim(),
    gradeLevel: Number(input.gradeLevel || 1),
    gradeUpDate: String(input.gradeUpDate || '').trim(),
    gradeSetDate: String(input.gradeSetDate || '').trim(),
    gradeNextDate: String(input.gradeNextDate || '').trim(),
    preSchool: String(input.preSchool || '').trim(),
    preMajor: String(input.preMajor || '').trim(),
    postSchool: String(input.postSchool || '').trim(),
    postMajor: String(input.postMajor || '').trim(),
    etc: String(input.etc || '').trim(),
  };
}

// 형식 + 실제 달력 유효성(2026-99-99 등 차단): 구성요소가 Date로 왕복해도 동일한지 확인
function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function validateEmployee(emp, employees, originalEmpNo = '') {
  if (!emp.name) return '성명을 입력해 주세요.';
  if (!emp.empNo || !/^\d+$/.test(emp.empNo)) return '직원번호는 숫자로 입력해 주세요.';
  if (employees.some(e => e.empNo === emp.empNo && e.empNo !== originalEmpNo)) return '이미 사용 중인 직원번호입니다.';
  if (!emp.dept) return '부서를 입력해 주세요.';
  if (!emp.team) return '팀을 입력해 주세요.';
  if (!isValidDate(emp.joinDate)) return '입행일은 실제 존재하는 YYYY-MM-DD 날짜로 입력해 주세요.';
  if (!emp.birthYear || emp.birthYear < 1900 || emp.birthYear > new Date().getFullYear()) return '출생년도를 올바르게 입력해 주세요.';
  if (!isValidDate(emp.birth)) return '생년월일은 실제 존재하는 YYYY-MM-DD 날짜로 입력해 주세요.';
  if (emp.gradeLevel < 1) return '등급은 1 이상으로 입력해 주세요.';
  for (const key of ['gradeUpDate', 'gradeSetDate', 'gradeNextDate']) {
    if (emp[key] && !isValidDate(emp[key])) return '직급/등급 날짜는 실제 존재하는 YYYY-MM-DD 날짜로 입력해 주세요.';
  }
  return '';
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
};

// 공개 가능한 정적 자산만 명시적으로 허용 (서버 소스/데이터/.git 등은 일절 노출하지 않음)
const PUBLIC_ROOT_FILES = new Set(['index.html', 'app.js', 'style.css']);
const LIBS_DIR = path.join(ROOT, 'libs');

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(ROOT, rel);

  // 허용 판정은 '정규화된 resolved 경로' 기준으로만 한다 (원본 문자열 기준 traversal 우회 차단)
  const isPublicRoot = [...PUBLIC_ROOT_FILES].some(f => resolved === path.join(ROOT, f));
  const inLibs = resolved.startsWith(LIBS_DIR + path.sep);
  const allowedExt = Object.prototype.hasOwnProperty.call(STATIC_TYPES, path.extname(resolved));
  // '..' 및 숨김(.git/.env 등) 세그먼트는 명시적으로도 차단 (이중 방어)
  const badSeg = rel.split(/[\\/]/).some(seg => seg === '..' || seg.startsWith('.'));
  if (badSeg || !allowedExt || !(isPublicRoot || inLibs)) return send(res, 404, 'Not found');

  fs.readFile(resolved, (err, data) => {
    if (err) return send(res, 404, 'Not found'); // 디렉터리는 EISDIR로 걸러짐
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(resolved)],
      'Cache-Control': 'no-store',
      ...securityHeaders(),
    });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method !== 'GET' && !sameOrigin(req)) {
    return send(res, 403, { error: '허용되지 않은 요청 출처입니다.' });
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    const token = parseCookies(req).eims_session;
    const session = token && sessions.get(token);
    const now = Date.now();
    if (session && now - session.lastSeen <= SESSION_TTL_MS) {
      session.lastSeen = now;
      return send(res, 200, { authenticated: true });
    }
    if (token) sessions.delete(token);
    return send(res, 200, { authenticated: false });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const key = getClientKey(req);
    const state = authFailures.get(key) || { count: 0, lockUntil: 0 };
    const now = Date.now();
    if (state.lockUntil > now) {
      return send(res, 429, { error: `잠시 후 다시 시도해 주세요. (${Math.ceil((state.lockUntil - now) / 1000)}초)` });
    }
    const body = await readJson(req);
    const password = String(body.password || '');
    if (!PASSWORD_RULE.test(password)) return send(res, 400, { error: '비밀번호는 4자 이상 입력해 주세요.' });
    if (!verifyPassword(password)) {
      state.count += 1;
      if (state.count >= MAX_AUTH_FAILS) {
        state.count = 0;
        state.lockUntil = now + AUTH_LOCK_MS;
      }
      authFailures.set(key, state);
      return send(res, 401, { error: state.lockUntil > now ? '실패 횟수를 초과했습니다. 30초 후 다시 시도해 주세요.' : `비밀번호가 일치하지 않습니다. (${state.count}/${MAX_AUTH_FAILS})` });
    }
    authFailures.delete(key);
    createSession(res);
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    clearSession(req, res);
    return send(res, 200, { ok: true });
  }

  if (!requireSession(req, res)) return;

  // 비밀번호 변경: 현재 비밀번호 확인 → 새 비밀번호 규칙 검증 → 저장
  if (pathname === '/api/password' && req.method === 'POST') {
    const body = await readJson(req);
    const current = String(body.current || '');
    const next = String(body.next || '');
    if (!verifyPassword(current)) return send(res, 401, { error: '현재 비밀번호가 일치하지 않습니다.' });
    if (!PASSWORD_RULE.test(next)) return send(res, 400, { error: '새 비밀번호는 4자 이상이어야 합니다.' });
    if (next === current) return send(res, 400, { error: '새 비밀번호는 현재 비밀번호와 달라야 합니다.' });
    setPassword(next);
    // 보안: 비밀번호 변경 시 현재 세션을 제외한 다른 모든 세션을 무효화한다
    const myToken = parseCookies(req).eims_session;
    for (const token of [...sessions.keys()]) {
      if (token !== myToken) sessions.delete(token);
    }
    return send(res, 200, { ok: true });
  }

  if (pathname === '/api/evaluations' && req.method === 'GET') {
    return send(res, 200, { evaluations: loadEvaluations() });
  }

  if (pathname === '/api/evaluations' && req.method === 'PUT') {
    const body = await readJson(req);
    const data = normalizeEvaluations(body);
    saveEvaluations(data);
    return send(res, 200, { evaluations: data });
  }

  if (pathname === '/api/employees' && req.method === 'GET') {
    return send(res, 200, { employees: loadEmployees() });
  }

  if (pathname === '/api/employees' && req.method === 'POST') {
    const body = await readJson(req); // 본문을 먼저 읽어 load→save 사이 비동기 중단을 없앤다(동시 쓰기 경합 방지)
    const employees = loadEmployees();
    const nextNo = employees.reduce((m, e) => Math.max(m, Number(e.no) || 0), 0) + 1;
    const emp = normalizeEmployee({ ...body, no: nextNo });
    const err = validateEmployee(emp, employees);
    if (err) return send(res, 400, { error: err });
    employees.push(emp);
    saveEmployees(employees);
    return send(res, 201, { employee: emp });
  }

  if (pathname === '/api/employees/import' && req.method === 'POST') {
    const body = await readJson(req);
    const current = loadEmployees();
    const incoming = Array.isArray(body.employees) ? body.employees : [];
    const baseNo = body.replace ? 0 : current.reduce((m, e) => Math.max(m, Number(e.no) || 0), 0);
    const normalized = incoming.map((e, i) => normalizeEmployee({ ...e, no: baseNo + i + 1 }));
    const validationBase = body.replace ? normalized : current.concat(normalized);
    for (const emp of normalized) {
      const err = validateEmployee(emp, validationBase.filter(e => e !== emp));
      if (err) return send(res, 400, { error: err });
    }
    const next = body.replace ? normalized : current.concat(normalized);
    saveEmployees(next);
    return send(res, 200, { employees: next });
  }

  const match = pathname.match(/^\/api\/employees\/([^/]+)$/);
  if (match) {
    const empNo = decodeURIComponent(match[1]);
    // PUT 본문은 load 이전에 읽어 read-modify-write를 동기적으로 유지(경합 방지)
    const body = req.method === 'PUT' ? await readJson(req) : null;
    const employees = loadEmployees();
    const idx = employees.findIndex(e => e.empNo === empNo);
    if (idx < 0) return send(res, 404, { error: '직원을 찾을 수 없습니다.' });
    if (req.method === 'PUT') {
      const emp = normalizeEmployee(body, employees[idx]);
      const err = validateEmployee(emp, employees, empNo);
      if (err) return send(res, 400, { error: err });
      employees[idx] = emp;
      saveEmployees(employees);
      return send(res, 200, { employee: emp });
    }
    if (req.method === 'DELETE') {
      employees.splice(idx, 1);
      saveEmployees(employees);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET') return send(res, 200, { employee: employees[idx] });
  }

  return send(res, 404, { error: 'API endpoint not found.' });
}

// readJson에서 던지는 사용자 안내용 메시지만 클라이언트에 노출하고, 그 외 내부 오류는 일반화한다
const SAFE_ERRORS = new Set(['요청 데이터가 너무 큽니다.', 'JSON 형식이 올바르지 않습니다.']);

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return send(res, 400, 'Bad request');
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url.pathname).catch(err => {
      console.error('[EIMS] API error:', err);
      const msg = SAFE_ERRORS.has(err?.message) ? err.message : '서버 오류가 발생했습니다.';
      send(res, 500, { error: msg });
    });
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    return send(res, 400, 'Bad request');
  }
  serveStatic(req, res, pathname);
});

// 만료된 세션/잠금 상태 주기적 정리 (메모리 무한 증가 방지)
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(token);
  }
  for (const [key, st] of authFailures) {
    if (st.lockUntil <= now && st.count === 0) authFailures.delete(key);
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EIMS server running at http://0.0.0.0:${PORT}`);
});

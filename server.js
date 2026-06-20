const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'employees.json');
const PORT = Number(process.env.PORT || 7000);
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUTH_FAILS = 5;
const AUTH_LOCK_MS = 30 * 1000;
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const SECURE_COOKIE = process.env.EIMS_SECURE === '1';
const COOKIE_FLAGS = `HttpOnly; SameSite=Lax; Path=/${SECURE_COOKIE ? '; Secure' : ''}`;
const PASSWORD_HASH = resolvePasswordHash();

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

// 비밀번호 해시 결정: 환경변수 우선, 없으면 1회용 임시 비밀번호를 생성해 콘솔에 출력
// (소스코드에 비밀번호/해시를 절대 하드코딩하지 않는다)
function resolvePasswordHash() {
  const fromJson = parsePasswordHash(process.env.EIMS_PASSWORD_HASH_JSON);
  if (fromJson) return fromJson;

  const iterations = 310000;
  const digest = 'sha256';
  const salt = crypto.randomBytes(16);
  let password = process.env.EIMS_PASSWORD;
  const generated = !password;
  if (generated) password = generatePassword();

  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, digest);
  if (generated) {
    console.log('────────────────────────────────────────────');
    console.log('  EIMS 임시 접속 비밀번호 (이번 기동에서만 유효):');
    console.log(`     ${password}`);
    console.log('  영구 설정: EIMS_PASSWORD 또는 EIMS_PASSWORD_HASH_JSON 환경변수 사용');
    console.log('────────────────────────────────────────────');
  }
  return { iterations, salt: salt.toString('base64'), hash: hash.toString('base64'), digest };
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
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveEmployees(employees) {
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(employees, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, DATA_FILE);
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

function validateEmployee(emp, employees, originalEmpNo = '') {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!emp.name) return '성명을 입력해 주세요.';
  if (!emp.empNo || !/^\d+$/.test(emp.empNo)) return '직원번호는 숫자로 입력해 주세요.';
  if (employees.some(e => e.empNo === emp.empNo && e.empNo !== originalEmpNo)) return '이미 사용 중인 직원번호입니다.';
  if (!emp.dept) return '부서를 입력해 주세요.';
  if (!emp.team) return '팀을 입력해 주세요.';
  if (!dateRe.test(emp.joinDate)) return '입행일은 YYYY-MM-DD 형식으로 입력해 주세요.';
  if (!emp.birthYear || emp.birthYear < 1900 || emp.birthYear > new Date().getFullYear()) return '출생년도를 올바르게 입력해 주세요.';
  if (!dateRe.test(emp.birth)) return '생년월일은 YYYY-MM-DD 형식으로 입력해 주세요.';
  if (emp.gradeLevel < 1) return '등급은 1 이상으로 입력해 주세요.';
  for (const key of ['gradeUpDate', 'gradeSetDate', 'gradeNextDate']) {
    if (emp[key] && !dateRe.test(emp[key])) return '직급/등급 날짜는 YYYY-MM-DD 형식으로 입력해 주세요.';
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
    if (!PASSWORD_RULE.test(password)) return send(res, 400, { error: '영문, 숫자, 기호를 포함해 8자 이상 입력해 주세요.' });
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`EIMS server running at http://127.0.0.1:${PORT}`);
});

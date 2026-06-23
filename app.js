// ═══════════════════════════════════════
//  STATE
// ═══════════════════════════════════════
const S = {
  screen: 'dashboard',
  selectedEmpNo: null,
  formMode: 'edit',
  pendingScreen: 'dashboard',
  authenticated: false,
};
let EMP = [];
const charts = {};
const TODAY = new Date();
const EMP_PASSWORD_RULE = /^.{4,}$/; // 내부망용: 4자 이상이면 어떤 문자든 허용
const PROTECTED_SCREENS = new Set(['dashboard', 'emplist', 'stats', 'detail', 'evaluate']);

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
// HTML 텍스트/속성 컨텍스트 모두에서 안전하도록 이스케이프 (저장형 XSS 방지)
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function calcAge(by, birth) {
  const n = Number(by);
  if (!n) return '-';
  const age = TODAY.getFullYear() - n;
  const m = birth && /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth);
  if (!m) return age;
  const passed = (TODAY.getMonth() + 1) * 100 + TODAY.getDate() >= Number(m[2]) * 100 + Number(m[3]);
  return passed ? age : age - 1;
}

function calcYears(d) {
  const ms = TODAY - new Date(d);
  if (!Number.isFinite(ms)) return '-'; // 잘못된 날짜는 NaN년 대신 '-'
  const y = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
  const m = Math.floor((ms % (365.25 * 24 * 3600 * 1000)) / (30.44 * 24 * 3600 * 1000));
  return y + '년 ' + m + '개월';
}

const GRADS = [
  ['#FF4560', '#FF8C00'], ['#0066FF', '#26C6DA'], ['#00C853', '#F9A825'],
  ['#7C4DFF', '#E84D8A'], ['#E63946', '#FF6B6B'], ['#00BFA5', '#26C6DA'],
];
function grad(name) { return GRADS[name.charCodeAt(0) % GRADS.length]; }

const GI = {
  'L4':    { c: '#0066FF', b: 'rgba(0,102,255,.15)' },
  'L3':    { c: '#E63946', b: 'rgba(230,57,70,.15)' },
  'L2':    { c: '#F9A825', b: 'rgba(249,168,37,.15)' },
  'L1':    { c: '#8080A0', b: 'rgba(128,128,160,.15)' },
  'L3대우': { c: '#E84D8A', b: 'rgba(232,77,138,.15)' },
  'L2대우': { c: '#7C4DFF', b: 'rgba(124,77,255,.15)' },
  'L1대우': { c: '#26C6DA', b: 'rgba(38,198,218,.15)' },
};
function gi(g) { return GI[g] || GI['L1']; }

const TEAM_ORDER = ['여신심사팀', '여신업무팀', '여신관리팀', '외환팀', '상품/신용평가팀', 'PPR팀'];
function sortedTeams(emp) {
  const all = [...new Set(emp.map(e => e.team))];
  return all.sort((a, b) => {
    const ia = TEAM_ORDER.indexOf(a), ib = TEAM_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b, 'ko');
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
}
const DASH_TEAM_COLORS = ['#D05C6F', '#D98545', '#4EAF72', '#4E82C2', '#8A63C7', '#42B3AD'];
const DASH_GRADE_COLORS = {
  'L4': '#4F86D6',
  'L3': '#D05D64',
  'L2': '#D5A944',
  'L1': '#8A8DA5',
  'L3대우': '#C9639D',
  'L2대우': '#8966D0',
  'L1대우': '#49B7C0',
};
function dashGradeColor(g) { return DASH_GRADE_COLORS[g] || DASH_GRADE_COLORS['L1']; }

// ── 인사평가(평가하기) ── (라이트모드 대비 가독성 좋은 색)
const EVAL_GRADES = [
  { key: 'S', label: '탁월',     color: '#B38600' },
  { key: 'A', label: '우수',     color: '#2E8B57' },
  { key: 'G', label: '양호',     color: '#3B7DD8' },
  { key: 'C', label: '노력필요', color: '#C77A2E' },
  { key: 'D', label: '부진',     color: '#C0282F' },
];
const EVAL_PERIODS = [
  { key: '2025-H1', label: '2025 상반기' }, { key: '2025-H2', label: '2025 하반기' },
  { key: '2026-H1', label: '2026 상반기' }, { key: '2026-H2', label: '2026 하반기' },
  { key: '2027-H1', label: '2027 상반기' }, { key: '2027-H2', label: '2027 하반기' },
];
// ratios: 등급별 목표 비율(%), data: { 직원번호: { 평가기간: 등급 } }, mult: { 직원번호: 배수횟수 }
// confirmed: { 평가기간: true } — 최종 확정되어 수정 잠긴 기간
const EVAL = { ratios: { S: 0, A: 0, G: 0, C: 0, D: 0 }, data: {}, mult: {}, awards: {}, confirmed: {}, loaded: false, periodInit: false };

function av(name, sz = 27) {
  const safe = String(name || '?');
  const [g1, g2] = grad(safe);
  return `<div style="width:${sz}px;height:${sz}px;background:linear-gradient(135deg,${g1},${g2});border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${Math.round(sz * .37)}px;font-weight:700;color:#0F0F14;flex-shrink:0">${esc(safe[0])}</div>`;
}

function gtag(grade) {
  const { c, b } = gi(grade);
  return `<span style="font-size:11px;font-weight:600;color:${c};background:${b};padding:2px 8px;border-radius:4px;white-space:nowrap">${esc(grade)}</span>`;
}

function resetCharts() {
  Object.keys(charts).forEach(k => { charts[k]?.destroy?.(); delete charts[k]; });
}

function refreshViews() {
  resetCharts();
  renderHeader();
  renderDept(); // 팀별 카드는 이제 대시보드에 표시됨
  if (S.screen === 'emplist') renderEmpList();
  if (S.screen === 'detail' && S.selectedEmpNo) renderDetail();
  setTimeout(initCharts, 100);
}

// ═══════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════
function navigate(screen) {
  if (needsAuth(screen) && !S.authenticated) {
    S.pendingScreen = screen;
    openPasswordGate();
    return;
  }
  // 평가하기 메뉴는 진입 시마다 접속 비밀번호를 한 번 더 확인한다
  if (screen === 'evaluate' && S.authenticated) {
    openEvalAuth();
    return;
  }
  activateScreen(screen);
}

function activateScreen(screen) {
  S.screen = screen;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn[data-screen]').forEach(b => b.classList.remove('active'));
  const sc = document.getElementById('screen-' + screen);
  if (sc) sc.classList.add('active');
  const nb = document.querySelector(`[data-screen="${screen}"]`);
  if (nb) nb.classList.add('active');
  const titles = { dashboard: '대시보드', emplist: '직원 목록', stats: '통계 분석', detail: '직원 상세', evaluate: '평가하기' };
  const pt = document.getElementById('page-title');
  if (pt) pt.textContent = titles[screen] || screen;
  if (screen === 'dashboard') { renderHeader(); renderDept(); }
  if (screen === 'emplist') { sortState = []; renderEmpList(); }
  if (screen === 'detail') renderDetail();
  if (screen === 'stats')  { renderHeader(); renderStatLists(); ['age','tenure','level','dd'].forEach(k => { charts[k]?.destroy?.(); delete charts[k]; }); }
  if (screen === 'evaluate') renderEvaluate();
  initCharts();
}

function needsAuth(screen) {
  return PROTECTED_SCREENS.has(screen);
}

function openPasswordGate() {
  const modal = document.getElementById('pw-modal');
  const input = document.getElementById('pw-input');
  const err = document.getElementById('pw-error');
  if (!modal || !input) return;
  if (err) err.textContent = '';
  input.value = '';
  modal.classList.add('show');
  setTimeout(() => input.focus(), 50);
}

function closePasswordGate() {
  const modal = document.getElementById('pw-modal');
  const err = document.getElementById('pw-error');
  if (!S.authenticated) {
    window.close();
    setTimeout(() => {
      if (!window.closed) {
        const err = document.getElementById('pw-error');
        if (err) err.textContent = '창을 직접 닫아 주세요.';
      }
    }, 300);
    return;
  }
  if (modal) modal.classList.remove('show');
  if (err) err.textContent = '';
}

async function apiRequest(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.authenticated) {
    // 세션 만료: 인증 상태를 내리고 다시 잠금 화면을 띄운다
    S.authenticated = false;
    sessionStorage.removeItem('eims_auth');
    stopIdleTimer();
    openPasswordGate();
  }
  if (!res.ok) throw new Error(data.error || '요청 처리 중 오류가 발생했습니다.');
  return data;
}

// ═══════════════════════════════════════
//  유휴(IDLE) 자동 로그아웃
// ═══════════════════════════════════════
// 로그인 상태에서 사용자 입력이 IDLE_TIMEOUT_MS 동안 전혀 없으면 자동으로 로그아웃하고
// 잠금 화면을 띄운다. (서버 세션 TTL과 동일한 30분으로 맞춘다)
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
let idleTimer = null;

function resetIdleTimer() {
  if (!S.authenticated) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(handleIdleTimeout, IDLE_TIMEOUT_MS);
}

function stopIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

// 세션 종료 공통 처리: 서버 세션 무효화 + 로컬 인증 상태 해제 + 잠금 화면 표시
async function endSession() {
  if (!S.authenticated) return;
  // 먼저 인증 상태를 내려야 apiRequest의 401 처리와 중복으로 잠금 화면이 뜨지 않는다
  S.authenticated = false;
  sessionStorage.removeItem('eims_auth');
  stopIdleTimer();
  try {
    await apiRequest('/api/logout', { method: 'POST' });
  } catch (_) {}
  S.pendingScreen = S.screen;
  openPasswordGate();
}

function handleIdleTimeout() {
  return endSession();
}

// 사용자가 직접 로그아웃
function doLogout() {
  if (!S.authenticated) return;
  if (!confirm('로그아웃하시겠습니까?')) return;
  endSession();
}

// 사용자 활동 감지: 어떤 입력이라도 있으면 유휴 타이머를 리셋한다
['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'].forEach(type => {
  document.addEventListener(type, resetIdleTimer, { passive: true });
});

async function loadEmployees() {
  const data = await apiRequest('/api/employees');
  EMP = data.employees || [];
  refreshViews();
}

async function submitPasswordGate() {
  const input = document.getElementById('pw-input');
  const err = document.getElementById('pw-error');
  const val = input?.value || '';
  if (!EMP_PASSWORD_RULE.test(val)) {
    if (err) err.textContent = '비밀번호는 4자 이상 입력해 주세요.';
    return;
  }
  try {
    await apiRequest('/api/login', { method: 'POST', body: JSON.stringify({ password: val }) });
    S.authenticated = true;
    sessionStorage.setItem('eims_auth', '1');
    resetIdleTimer();
    await loadEmployees();
  } catch (e) {
    if (err) err.textContent = e.message;
    input?.focus();
    return;
  }
  const target = S.pendingScreen || 'emplist';
  closePasswordGate();
  activateScreen(target);
}

function handlePasswordKey(ev) {
  if (ev.key === 'Enter') submitPasswordGate();
  if (ev.key === 'Escape') closePasswordGate();
}

// ═══════════════════════════════════════
//  비밀번호 변경 (현재 → 새 → 확인 차례로 입력)
// ═══════════════════════════════════════
const CPW_FIELDS = ['cpw-current', 'cpw-new', 'cpw-confirm'];

function openChangePw() {
  if (!S.authenticated) { S.pendingScreen = S.screen; openPasswordGate(); return; }
  const modal = document.getElementById('cpw-modal');
  if (!modal) return;
  CPW_FIELDS.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const err = document.getElementById('cpw-error');
  if (err) err.textContent = '';
  modal.classList.add('show');
  setTimeout(() => document.getElementById('cpw-current')?.focus(), 50);
}

function closeChangePw() {
  const modal = document.getElementById('cpw-modal');
  if (modal) modal.classList.remove('show');
}

// Enter는 다음 칸으로 이동(마지막 칸에선 제출), Escape는 닫기
function handleChangePwKey(el, ev) {
  if (ev.key === 'Escape') { closeChangePw(); return; }
  if (ev.key !== 'Enter') return;
  const idx = CPW_FIELDS.indexOf(el.id);
  if (idx >= 0 && idx < CPW_FIELDS.length - 1) {
    document.getElementById(CPW_FIELDS[idx + 1])?.focus();
  } else {
    submitChangePw();
  }
}

async function submitChangePw() {
  const cur = document.getElementById('cpw-current');
  const nw = document.getElementById('cpw-new');
  const cf = document.getElementById('cpw-confirm');
  const err = document.getElementById('cpw-error');
  const current = cur?.value || '';
  const next = nw?.value || '';
  const confirmVal = cf?.value || '';
  const fail = (msg, focus) => { if (err) err.textContent = msg; focus?.focus(); };
  if (!current) return fail('현재 비밀번호를 입력해 주세요.', cur);
  if (!EMP_PASSWORD_RULE.test(next)) return fail('새 비밀번호는 4자 이상이어야 합니다.', nw);
  if (next !== confirmVal) return fail('새 비밀번호 확인이 일치하지 않습니다.', cf);
  if (next === current) return fail('새 비밀번호는 현재 비밀번호와 달라야 합니다.', nw);
  try {
    await apiRequest('/api/password', { method: 'POST', body: JSON.stringify({ current, next }) });
  } catch (e) {
    return fail(e.message, cur);
  }
  closeChangePw();
  alert('비밀번호가 변경되었습니다.');
}

// ═══════════════════════════════════════
//  FILTER
// ═══════════════════════════════════════
function filtered() {
  const s  = document.getElementById('srch')?.value || '';
  const d  = document.getElementById('flt-team')?.value || 'all';
  const g  = document.getElementById('flt-grade')?.value || 'all';
  const gn = document.getElementById('flt-gender')?.value || 'all';
  return EMP.filter(e => {
    if (s && !e.name.includes(s) && !e.empNo.includes(s) && !e.team.includes(s) && !e.pos.includes(s) && !String(e.birthYear).includes(s)) return false;
    if (d  !== 'all' && e.team.replace(/팀$/, '') !== d.replace(/팀$/, ''))  return false;
    if (g  !== 'all' && e.grade  !== g)  return false;
    if (gn !== 'all' && e.gender !== gn) return false;
    return true;
  });
}

const GRADE_ORDER = { 'L4': 4, 'L3': 3, 'L2': 2, 'L1': 1, 'L3대우': 3, 'L2대우': 2, 'L1대우': 1 };

// 헤더 클릭 정렬 키 → 값 추출기/타입 (num은 수치, str은 한글 로케일 문자열 비교)
const SORT_COLS = {
  dept:         { type: 'str', get: e => e.dept },
  team:         { type: 'str', get: e => e.team },
  name:         { type: 'str', get: e => e.name },
  empNo:        { type: 'num', get: e => Number(e.empNo) || 0 },
  pos:          { type: 'str', get: e => e.pos },
  grade:        { type: 'num', get: e => GRADE_ORDER[e.grade] || 0 },
  title:        { type: 'str', get: e => e.title },
  joinDate:     { type: 'str', get: e => e.joinDate || '' },
  tenure:       { type: 'num', get: e => new Date(e.joinDate).getTime() || 0 },
  birthYear:    { type: 'num', get: e => Number(e.birthYear) || 0 },
  age:          { type: 'num', get: e => Number(calcAge(e.birthYear, e.birth)) || 0 },
  birth:        { type: 'str', get: e => e.birth || '' },
  gender:       { type: 'str', get: e => e.gender },
  gradeUpDate:  { type: 'str', get: e => e.gradeUpDate || '' },
  gradeLevel:   { type: 'num', get: e => Number(e.gradeLevel) || 0 },
  gradeSetDate: { type: 'str', get: e => e.gradeSetDate || '' },
  gradeNextDate:{ type: 'str', get: e => e.gradeNextDate || '' },
  preSchool:    { type: 'str', get: e => e.preSchool || '' },
  preMajor:     { type: 'str', get: e => e.preMajor || '' },
  postSchool:   { type: 'str', get: e => e.postSchool || '' },
  postMajor:    { type: 'str', get: e => e.postMajor || '' },
  etc:          { type: 'str', get: e => e.etc || '' },
};

// 사용자가 클릭한 순서대로 누적되는 정렬 기준 [{key, dir}] (배열 순서 = 정렬 우선순위)
let sortState = [];

// 헤더 클릭: 미정렬→오름차순 추가, 오름차순→내림차순, 내림차순→해제(3번째 클릭)
function toggleSort(key) {
  if (!SORT_COLS[key]) return;
  const i = sortState.findIndex(s => s.key === key);
  if (i < 0) sortState.push({ key, dir: 'asc' });
  else if (sortState[i].dir === 'asc') sortState[i].dir = 'desc';
  else sortState.splice(i, 1);
  renderEmpList();
}

function userSortCmp(a, b) {
  for (const { key, dir } of sortState) {
    const col = SORT_COLS[key];
    if (!col) continue;
    const va = col.get(a), vb = col.get(b);
    const c = col.type === 'num' ? (va - vb) : String(va).localeCompare(String(vb), 'ko');
    if (c) return dir === 'desc' ? -c : c;
  }
  return 0;
}

// 헤더 ::after 정렬 표시(▲/▼ + 다중정렬 시 우선순위 번호) 갱신
function updateSortIndicators() {
  document.querySelectorAll('#emp-table th[data-sort]').forEach(th => {
    const i = sortState.findIndex(s => s.key === th.dataset.sort);
    if (i < 0) { th.removeAttribute('data-ind'); th.classList.remove('sort-active'); return; }
    const arrow = sortState[i].dir === 'asc' ? '▲' : '▼';
    th.dataset.ind = ` ${arrow}${sortState.length > 1 ? i + 1 : ''}`;
    th.classList.add('sort-active');
  });
}

function sortEmpList(list) {
  // 사용자가 헤더로 지정한 정렬이 있으면 그 기준(클릭 순서 우선)을 따른다
  if (sortState.length) return [...list].sort(userSortCmp);

  // 기본 정렬: 부장 → 일반 → 전문직무직원, 각 그룹은 직급/등급 기준
  const GO = GRADE_ORDER;
  const cmp = (a, b) => {
    const gd = (GO[b.grade] || 0) - (GO[a.grade] || 0);
    if (gd) return gd;
    const ud = (a.gradeUpDate || '').localeCompare(b.gradeUpDate || '');
    if (ud) return ud;
    const ld = b.gradeLevel - a.gradeLevel;
    if (ld) return ld;
    const sd = (a.gradeSetDate || '').localeCompare(b.gradeSetDate || '');
    if (sd) return sd;
    const nd = (a.gradeNextDate || '').localeCompare(b.gradeNextDate || '');
    if (nd) return nd;
    const by = a.birthYear - b.birthYear;
    if (by) return by;
    return (a.birth || '').localeCompare(b.birth || '');
  };
  const bujangs  = list.filter(e => e.pos === '부장').sort(cmp);
  const specials = list.filter(e => e.pos === '전문직무직원').sort(cmp);
  const normals  = list.filter(e => e.pos !== '부장' && e.pos !== '전문직무직원').sort(cmp);
  return [...bujangs, ...normals, ...specials];
}

// ═══════════════════════════════════════
//  STATS LISTS
// ═══════════════════════════════════════
const RETIRE_AGE = 55;
const RETIRE_NEAR = 2;

function renderStatLists() {
  const threeYearsAgo = new Date(TODAY.getFullYear() - 3, TODAY.getMonth(), TODAY.getDate());

  const retireList = EMP
    .filter(e => TODAY.getFullYear() - Number(e.birthYear) >= RETIRE_AGE - RETIRE_NEAR)
    .sort((a, b) => (a.birth || '').localeCompare(b.birth || ''));

  const newList = EMP
    .filter(e => e.joinDate && new Date(e.joinDate) >= threeYearsAgo)
    .sort((a, b) => (b.joinDate || '').localeCompare(a.joinDate || ''));

  const ROW_STYLE = 'border-bottom:1px solid #F2F2F7';
  const TD = (txt, style = '') => `<td style="padding:7px 10px;font-size:11px;color:#2C2C2E;${style}">${esc(String(txt ?? '-'))}</td>`;
  const TH = (txt) => `<th style="padding:6px 10px;font-size:10px;color:#636366;font-weight:500;text-align:left;border-bottom:1px solid #E5E5EA">${txt}</th>`;

  const retireSub = document.getElementById('st-retire-sub');
  const newSub    = document.getElementById('st-new-sub');
  if (retireSub) retireSub.textContent = `만 ${RETIRE_AGE - RETIRE_NEAR}세 이상 · ${retireList.length}명`;
  if (newSub)    newSub.textContent    = `최근 3년 이내 입행 · ${newList.length}명`;

  const retireEl = document.getElementById('st-retire-list');
  if (retireEl) {
    if (!retireList.length) {
      retireEl.innerHTML = '<div style="text-align:center;color:#8E8E93;font-size:12px;padding:20px 0">해당 직원 없음</div>';
    } else {
      retireEl.innerHTML = `<table style="width:100%;border-collapse:collapse">
        <thead><tr>${TH('성명')}${TH('팀')}${TH('직위')}${TH('호칭')}${TH('생년월일')}${TH('만나이')}</tr></thead>
        <tbody>${retireList.map(e => `<tr style="${ROW_STYLE}">
          ${TD(e.name, 'color:#1C1C1E;font-weight:500')}
          ${TD(e.team)}${TD(e.pos)}${TD(e.title)}
          ${TD(e.birth || '-')}
          ${TD(calcAge(e.birthYear, e.birth) + '세', 'color:#B38600;font-weight:600')}
        </tr>`).join('')}</tbody>
      </table>`;
    }
  }

  const newEl = document.getElementById('st-new-list');
  if (newEl) {
    if (!newList.length) {
      newEl.innerHTML = '<div style="text-align:center;color:#8E8E93;font-size:12px;padding:20px 0">해당 직원 없음</div>';
    } else {
      newEl.innerHTML = `<table style="width:100%;border-collapse:collapse">
        <thead><tr>${TH('성명')}${TH('팀')}${TH('직위')}${TH('호칭')}${TH('입행일')}</tr></thead>
        <tbody>${newList.map(e => `<tr style="${ROW_STYLE}">
          ${TD(e.name, 'color:#1C1C1E;font-weight:500')}
          ${TD(e.team)}${TD(e.pos)}${TD(e.title)}
          ${TD(e.joinDate, 'color:#2E8B57;font-weight:500')}
        </tr>`).join('')}</tbody>
      </table>`;
    }
  }
}

// ═══════════════════════════════════════
//  HEADER / KPI
// ═══════════════════════════════════════
function renderHeader() {
  const d = TODAY;
  const dateEl = document.getElementById('cur-date');
  if (dateEl) dateEl.textContent = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}.${String(d.getDate()).padStart(2,'0')}`;
  const total = document.getElementById('kpi-total');
  if (total) total.textContent = EMP.length;
  const depts = document.getElementById('kpi-depts');
  if (depts) depts.textContent = [...new Set(EMP.map(e => e.team))].length + '개 팀';

  const n = EMP.length;
  const avgY  = n ? EMP.reduce((s, e) => s + (TODAY - new Date(e.joinDate)), 0) / n / (365.25 * 24 * 3600 * 1000) : 0;
  const kpiAvg = document.getElementById('kpi-avg');
  if (kpiAvg) kpiAvg.innerHTML = `<span style="font-size:22px;font-weight:700;color:#F46600">${avgY.toFixed(1)}</span><span style="font-size:13px;color:#8080AA">년</span>`;

  const male = EMP.filter(e => e.gender === '남').length;
  const pct = part => n ? Math.round(part / n * 100) : 0;
  const malePct = document.getElementById('kpi-male-pct');
  if (malePct) malePct.textContent = pct(male) + '%';
  const femalePct = document.getElementById('kpi-female-pct');
  if (femalePct) femalePct.textContent = pct(n - male) + '%';
  const retire = document.getElementById('kpi-retire');
  if (retire) retire.textContent = EMP.filter(e => TODAY.getFullYear() - Number(e.birthYear) >= 53).length + '명';

  const stTotal = document.getElementById('st-total');
  if (stTotal) stTotal.textContent = n;
  const stMale = document.getElementById('st-male');
  if (stMale) stMale.textContent = male;
  const stMaleU = document.getElementById('st-male-u');
  if (stMaleU) stMaleU.textContent = `명 (${pct(male)}%)`;
  const stFemale = document.getElementById('st-female');
  if (stFemale) stFemale.textContent = n - male;
  const stFemaleU = document.getElementById('st-female-u');
  if (stFemaleU) stFemaleU.textContent = `명 (${pct(n - male)}%)`;
}

// ═══════════════════════════════════════
//  EMPLOYEE LIST
// ═══════════════════════════════════════
function renderEmpList() {
  const list = sortEmpList(filtered());
  const tbody = document.getElementById('emp-tbody');
  const cnt = document.getElementById('flt-count');
  if (cnt) cnt.textContent = list.length;
  if (!tbody) return;
  tbody.innerHTML = list.map((e, i) => {
    const gc = e.gender === '남' ? '#5B9BD5' : '#E84D8A';
    const isSpec = e.pos === '전문직무직원';
    const db = isSpec ? `<span class="db s">${esc(e.pos)}</span>` : '';
    return `<tr data-dblclick="openDetail" data-empno="${esc(e.empNo)}">
      <td class="c" style="color:#8E8E93">${i + 1}</td>
      <td style="color:#2C2C2E">${esc(e.dept)}</td>
      <td style="color:#2C2C2E">${esc(e.team)}</td>
      <td><div style="display:flex;align-items:center;gap:7px">${av(e.name, 22)}<span style="color:#1C1C1E;font-weight:500">${esc(e.name)}</span>${db}</div></td>
      <td style="color:#8E8E93;font-size:11px">${esc(e.empNo)}</td>
      <td style="color:#2C2C2E">${esc(e.pos)}</td>
      <td class="c">${gtag(e.grade)}</td>
      <td style="color:#2C2C2E">${esc(e.title)}</td>
      <td style="color:#3A3A3C">${esc(e.joinDate)}</td>
      <td style="color:#3A3A3C;font-size:11px">${calcYears(e.joinDate)}</td>
      <td class="c" style="color:#3A3A3C">${esc(e.birthYear)}</td>
      <td class="c" style="color:#3A3A3C">${calcAge(e.birthYear, e.birth)}세</td>
      <td style="color:#3A3A3C">${esc(e.birth)}</td>
      <td class="c" style="color:${gc}">${esc(e.gender)}</td>
      <td style="color:#3A3A3C">${esc(e.gradeUpDate) || '-'}</td>
      <td class="c" style="color:#1C1C1E">${esc(e.gradeLevel)}</td>
      <td style="color:#3A3A3C">${esc(e.gradeSetDate) || '-'}</td>
      <td style="color:#3A3A3C">${esc(e.gradeNextDate) || '-'}</td>
      <td class="edu-col" style="color:#3A3A3C">${esc(e.preSchool) || '-'}</td>
      <td class="edu-col" style="color:#3A3A3C">${esc(e.preMajor) || '-'}</td>
      <td class="edu-col" style="color:#3A3A3C">${esc(e.postSchool) || '-'}</td>
      <td class="edu-col" style="color:#3A3A3C">${esc(e.postMajor) || '-'}</td>
      <td class="edu-col" style="color:#3A3A3C">${esc(e.etc) || '-'}</td>
    </tr>`;
  }).join('');
  updateSortIndicators();
}

function toggleEduCols() {
  const tbl  = document.getElementById('emp-table');
  const icon = document.getElementById('edu-toggle-icon');
  if (!tbl) return;
  const hidden = tbl.classList.toggle('edu-hidden');
  if (icon) icon.textContent = hidden ? '▶' : '▼';
}

// ═══════════════════════════════════════
//  EMPLOYEE DETAIL
// ═══════════════════════════════════════
function openDetail(empNo) {
  S.selectedEmpNo = empNo;
  navigate('detail');
}

function renderDetail() {
  const emp = EMP.find(e => e.empNo === S.selectedEmpNo);
  if (!emp) {
    document.getElementById('det-hd').innerHTML = '';
    document.getElementById('det-grid').innerHTML = '';
    return;
  }
  const gc = emp.gender === '남' ? '#5B9BD5' : '#E84D8A';

  document.getElementById('det-hd').innerHTML = `
    <div style="display:flex;align-items:center;gap:16px">
      ${av(emp.name, 52)}
      <div>
        <div style="font-size:20px;font-weight:700;color:#E8E8F0">${esc(emp.name)}</div>
        <div style="font-size:11px;color:#9090BC;margin-bottom:10px">${esc(emp.dept)} · ${esc(emp.team)} · ${esc(emp.title)}</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap">
          ${gtag(emp.grade)}
          <span style="font-size:11px;color:#8080AA;background:rgba(255,255,255,.05);padding:4px 12px;border-radius:20px">직원번호 ${esc(emp.empNo)}</span>
          <span style="font-size:11px;color:#8080AA;background:rgba(255,255,255,.05);padding:4px 12px;border-radius:20px">등급 ${esc(emp.gradeLevel)}</span>
        </div>
      </div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:#6C6C90;margin-bottom:4px">입행일</div>
      <div style="font-size:15px;font-weight:600;color:#C8C8E0">${esc(emp.joinDate)}</div>
      <div style="font-size:11px;color:#FFBC00;margin-top:4px;font-weight:500">${calcYears(emp.joinDate)}</div>
    </div>`;

  document.getElementById('det-grid').innerHTML = `
    <div class="det-card">
      <div class="det-sec" style="color:#FFBC00">기본 정보</div>
      <div class="det-row"><span class="det-lbl">생년월일</span><span class="det-val">${esc(emp.birth)}</span></div>
      <div class="det-row"><span class="det-lbl">나이(만)</span><span class="det-val">${calcAge(emp.birthYear, emp.birth)}세</span></div>
      <div class="det-row"><span class="det-lbl">성별</span><span style="font-size:12px;color:${gc};font-weight:500">${emp.gender === '남' ? '남성' : '여성'}</span></div>
      <div class="det-row"><span class="det-lbl">직위</span><span class="det-val">${esc(emp.pos)}</span></div>
      <div class="det-row"><span class="det-lbl">호칭</span><span class="det-val">${esc(emp.title)}</span></div>
    </div>
    <div class="det-card">
      <div class="det-sec" style="color:#E63946">직급 정보</div>
      <div class="det-row"><span class="det-lbl">직급</span>${gtag(emp.grade)}</div>
      <div class="det-row"><span class="det-lbl">등급</span><span class="det-val">${esc(emp.gradeLevel)}</span></div>
      <div class="det-row"><span class="det-lbl">현직급 승격일</span><span class="det-val">${esc(emp.gradeUpDate) || '-'}</span></div>
      <div class="det-row"><span class="det-lbl">현등급 책정일</span><span class="det-val">${esc(emp.gradeSetDate) || '-'}</span></div>
      <div class="det-row"><span class="det-lbl">차기등급일</span><span class="det-val">${esc(emp.gradeNextDate) || '-'}</span></div>
      <div class="det-row"><span class="det-lbl">근속기간</span><span style="font-size:12px;color:#FFBC00;font-weight:500">${calcYears(emp.joinDate)}</span></div>
    </div>
    <div class="det-card">
      <div class="det-sec" style="color:#0066FF">학력 사항</div>
      ${emp.preSchool ? `
        <div class="school-lbl">입행 전 학교</div>
        <div class="school-nm">${esc(emp.preSchool)}</div>
        <div class="school-mj">${esc(emp.preMajor)}</div>` : '<div class="det-row"><span class="det-lbl">입행전</span><span class="det-val">-</span></div>'}
      ${emp.postSchool ? `
        <div class="school-div"></div>
        <div class="school-lbl">입행 후 학교</div>
        <div class="school-nm">${esc(emp.postSchool)}</div>
        <div class="school-mj">${esc(emp.postMajor)}</div>` : ''}
    </div>
    <div class="det-card">
      <div class="det-sec" style="color:#9090BC">기타 정보</div>
      <div class="det-row"><span class="det-val">${esc(emp.etc) || '-'}</span></div>
      <div class="det-acts">
        <button class="act-btn p" data-click="openEdit">정보 수정</button>
        <button class="act-btn d" data-click="deleteEmployee" data-empno="${esc(emp.empNo)}">직원 삭제</button>
      </div>
    </div>`;
}

// ═══════════════════════════════════════
//  ADD / EDIT / DELETE
// ═══════════════════════════════════════
const FIELD_OPTIONS = {
  gender: ['남', '여'],
  pos: ['부장', '팀장', '팀원', '전문직무직원'],
  title: ['부장', '팀장', '수석차장', '차장', '과장', '대리'],
  grade: ['L4', 'L3', 'L2', 'L1', 'L3대우', 'L2대우', 'L1대우'],
};

function selOpt(options, val) {
  return options.map(o => `<option value="${esc(o)}"${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('');
}

function emptyEmployee() {
  return {
    no: EMP.reduce((m, e) => Math.max(m, e.no || 0), 0) + 1,
    dept: '여신IT개발부',
    team: '',
    name: '',
    empNo: '',
    pos: '팀원',
    grade: 'L1',
    title: '대리',
    joinDate: '',
    birthYear: '',
    birth: '',
    gender: '남',
    gradeLevel: 1,
    gradeUpDate: '',
    gradeSetDate: '',
    gradeNextDate: '',
    preSchool: '',
    preMajor: '',
    postSchool: '',
    postMajor: '',
    etc: '',
  };
}

function openEdit() {
  const emp = EMP.find(e => e.empNo === S.selectedEmpNo);
  if (!emp) return;
  renderEmployeeForm(emp, 'edit');
}

function openEditFromList(empNo, ev) {
  ev?.stopPropagation?.();
  S.selectedEmpNo = empNo;
  navigate('detail');
  openEdit();
}

function openAdd() {
  S.selectedEmpNo = null;
  navigate('detail');
  renderEmployeeForm(emptyEmployee(), 'add');
}

function renderEmployeeForm(emp, mode) {
  S.formMode = mode;
  const f = (id, label, val, extra = '') => `
    <div class="edt-group">
      <label class="edt-lbl">${label}</label>
      <input id="${id}" class="edt-inp" value="${esc(val)}" ${extra}/>
    </div>`;
  const fs = (id, label, opts, val) => `
    <div class="edt-group">
      <label class="edt-lbl">${label}</label>
      <select id="${id}" class="edt-inp">${selOpt(opts, val)}</select>
    </div>`;
  const full = (id, label, val) => `
    <div class="edt-group edt-full">
      <label class="edt-lbl">${label}</label>
      <input id="${id}" class="edt-inp" value="${esc(val)}"/>
    </div>`;

  document.getElementById('det-hd').innerHTML = `
    <div style="display:flex;align-items:center;gap:16px">
      ${av(emp.name || '신규', 52)}
      <div>
        <div style="font-size:20px;font-weight:700;color:#E8E8F0">${mode === 'add' ? '직원 추가' : '직원정보 수정'}</div>
        <div style="font-size:11px;color:#9090BC;margin-top:4px">${mode === 'add' ? '신규 직원 정보를 입력합니다.' : `${esc(emp.name)} · ${esc(emp.empNo)}`}</div>
      </div>
    </div>`;

  document.getElementById('det-grid').innerHTML = `
    <div class="det-card">
      <div class="det-sec" style="color:#FFBC00">기본 정보</div>
      <div class="edt-grid">
        ${f('ef-name', '성명', emp.name)}
        ${f('ef-empNo', '직원번호', emp.empNo)}
        ${f('ef-dept', '부서', emp.dept)}
        ${f('ef-team', '팀', emp.team)}
        ${f('ef-joinDate', '입행일', emp.joinDate, 'placeholder="YYYY-MM-DD"')}
        ${f('ef-birthYear', '출생년도', emp.birthYear, 'type="number"')}
        ${f('ef-birth', '생년월일', emp.birth, 'placeholder="YYYY-MM-DD"')}
        ${fs('ef-gender', '성별', FIELD_OPTIONS.gender, emp.gender)}
        ${fs('ef-pos', '직위', FIELD_OPTIONS.pos, emp.pos)}
        ${fs('ef-title', '호칭', FIELD_OPTIONS.title, emp.title)}
      </div>
    </div>
    <div class="det-card">
      <div class="det-sec" style="color:#E63946">직급 정보</div>
      <div class="edt-grid">
        ${fs('ef-grade', '직급', FIELD_OPTIONS.grade, emp.grade)}
        ${f('ef-gradeLevel', '등급', emp.gradeLevel, 'type="number" min="1"')}
        ${f('ef-gradeUpDate', '현직급 승격일', emp.gradeUpDate, 'placeholder="YYYY-MM-DD"')}
        ${f('ef-gradeSetDate', '현등급 책정일', emp.gradeSetDate, 'placeholder="YYYY-MM-DD"')}
        ${f('ef-gradeNextDate', '차기등급일', emp.gradeNextDate, 'placeholder="YYYY-MM-DD"')}
      </div>
    </div>
    <div class="det-card">
      <div class="det-sec" style="color:#0066FF">학력 사항</div>
      <div class="edt-grid">
        ${f('ef-preSchool', '입행전 학교명', emp.preSchool)}
        ${f('ef-preMajor', '입행전 전공', emp.preMajor)}
        ${f('ef-postSchool', '입행후 학교명', emp.postSchool)}
        ${f('ef-postMajor', '입행후 전공', emp.postMajor)}
      </div>
    </div>
    <div class="det-card">
      <div class="det-sec" style="color:#9090BC">기타 정보</div>
      <div class="edt-grid">
        ${full('ef-etc', '특이사항', emp.etc)}
      </div>
      <div class="det-acts" style="margin-top:16px">
        <button class="act-btn s" data-click="cancelEdit">취소</button>
        <button class="act-btn p" data-click="saveEmployeeForm">${mode === 'add' ? '추가' : '저장'}</button>
      </div>
    </div>`;
}

function readEmployeeForm(base) {
  const v  = id => document.getElementById(id)?.value.trim() || '';
  const vi = id => parseInt(document.getElementById(id)?.value) || 0;
  return {
    ...base,
    name: v('ef-name'),
    empNo: v('ef-empNo'),
    dept: v('ef-dept'),
    team: v('ef-team'),
    joinDate: v('ef-joinDate'),
    birthYear: vi('ef-birthYear') || base.birthYear || 0,
    birth: v('ef-birth'),
    gender: v('ef-gender'),
    pos: v('ef-pos'),
    title: v('ef-title'),
    grade: v('ef-grade'),
    gradeLevel: vi('ef-gradeLevel') || base.gradeLevel || 1,
    gradeUpDate: v('ef-gradeUpDate'),
    gradeSetDate: v('ef-gradeSetDate'),
    gradeNextDate: v('ef-gradeNextDate'),
    preSchool: v('ef-preSchool'),
    preMajor: v('ef-preMajor'),
    postSchool: v('ef-postSchool'),
    postMajor: v('ef-postMajor'),
    etc: v('ef-etc'),
  };
}

// 형식 + 실제 달력 유효성(2026-99-99 등 차단)
function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function validateEmployee(emp, originalEmpNo = '') {
  if (!emp.name) return '성명을 입력해 주세요.';
  if (!emp.empNo) return '직원번호를 입력해 주세요.';
  if (!/^\d+$/.test(emp.empNo)) return '직원번호는 숫자만 입력해 주세요.';
  if (!emp.dept) return '부서를 입력해 주세요.';
  if (!emp.team) return '팀을 입력해 주세요.';
  if (!isValidDate(emp.joinDate)) return '입행일은 실제 존재하는 YYYY-MM-DD 날짜로 입력해 주세요.';
  if (!emp.birthYear || emp.birthYear < 1900 || emp.birthYear > TODAY.getFullYear()) return '출생년도를 올바르게 입력해 주세요.';
  if (!isValidDate(emp.birth)) return '생년월일은 실제 존재하는 YYYY-MM-DD 날짜로 입력해 주세요.';
  if (emp.gradeLevel < 1) return '등급은 1 이상으로 입력해 주세요.';
  for (const key of ['gradeUpDate', 'gradeSetDate', 'gradeNextDate']) {
    if (emp[key] && !isValidDate(emp[key])) return '직급/등급 날짜는 실제 존재하는 YYYY-MM-DD 날짜로 입력해 주세요.';
  }
  if (EMP.some(e => e.empNo === emp.empNo && e.empNo !== originalEmpNo)) return '이미 사용 중인 직원번호입니다.';
  return '';
}

async function saveEmployeeForm() {
  const mode = S.formMode;
  const current = mode === 'add' ? emptyEmployee() : EMP.find(e => e.empNo === S.selectedEmpNo);
  if (!current) return;
  const next = readEmployeeForm(current);
  const err = validateEmployee(next, mode === 'add' ? '' : current.empNo);
  if (err) { alert(err); return; }

  try {
    const endpoint = mode === 'add' ? '/api/employees' : `/api/employees/${encodeURIComponent(current.empNo)}`;
    const method = mode === 'add' ? 'POST' : 'PUT';
    const data = await apiRequest(endpoint, { method, body: JSON.stringify(next) });
    S.selectedEmpNo = data.employee.empNo;
    S.formMode = 'edit';
    await loadEmployees();
    renderDetail();
  } catch (e) {
    alert(e.message);
  }
}

function cancelEdit() {
  if (S.formMode === 'add') {
    S.formMode = 'edit';
    navigate('emplist');
    return;
  }
  renderDetail();
}

async function deleteEmployee(empNo, ev) {
  ev?.stopPropagation?.();
  const idx = EMP.findIndex(e => e.empNo === empNo);
  if (idx < 0) return;
  const emp = EMP[idx];
  if (!confirm(`${emp.name} (${emp.empNo}) 직원을 삭제하시겠습니까?`)) return;
  try {
    await apiRequest(`/api/employees/${encodeURIComponent(empNo)}`, { method: 'DELETE' });
    if (S.selectedEmpNo === empNo) S.selectedEmpNo = null;
    await loadEmployees();
    if (S.screen === 'detail') activateScreen('emplist');
  } catch (e) {
    alert(e.message);
  }
}

// ═══════════════════════════════════════
//  TEAM STATUS
// ═══════════════════════════════════════
function renderDept() {
  const teams = sortedTeams(EMP);
  document.getElementById('dept-cards').innerHTML = teams.map(t => {
    const te     = EMP.filter(e => e.team === t);
    const dept   = te[0].dept;
    const male   = te.filter(e => e.gender === '남').length;
    const avgAge = Math.round(te.reduce((s, e) => s + calcAge(e.birthYear), 0) / te.length);
    const l4 = te.filter(e => e.grade === 'L4').length;
    const l3 = te.filter(e => e.grade === 'L3').length;
    const l2 = te.filter(e => e.grade === 'L2').length;
    const l1 = te.filter(e => e.grade === 'L1').length;
    const [g1, g2] = grad(t);
    return `
      <div class="dept-card">
        <div class="dept-hd">
          <div>
            <div style="font-size:12px;font-weight:700;color:#1C1C1E">${esc(t)}</div>
          </div>
          <div style="width:28px;height:28px;background:linear-gradient(135deg,${g1},${g2});border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0">${esc(t[0])}</div>
        </div>
        <div style="display:flex;gap:6px;margin-bottom:10px">
          <div><div style="font-size:16px;font-weight:700;color:#1C1C1E">${te.length}</div><div style="font-size:10px;color:#636366">총원</div></div>
          <div><div style="font-size:16px;font-weight:700;color:#3B7DD8">${male}</div><div style="font-size:10px;color:#636366">남</div></div>
          <div><div style="font-size:16px;font-weight:700;color:#C93B7A">${te.length - male}</div><div style="font-size:10px;color:#636366">여</div></div>
          <div><div style="font-size:16px;font-weight:700;color:#B38600">${avgAge}</div><div style="font-size:10px;color:#636366">평균</div></div>
        </div>
        <div class="grade-grid">
          <div class="gc l1"><div class="gn">${l1}</div><div class="gl">L1</div></div>
          <div class="gc l2"><div class="gn">${l2}</div><div class="gl">L2</div></div>
          <div class="gc l3"><div class="gn">${l3}</div><div class="gl">L3</div></div>
          <div class="gc l4"><div class="gn">${l4}</div><div class="gl">L4</div></div>
        </div>
      </div>`;
  }).join('');
}

// ═══════════════════════════════════════
//  평가하기 (EVALUATION)
// ═══════════════════════════════════════
function evalGrade(key) { return EVAL_GRADES.find(g => g.key === key); }

// 평가 대상(부장 제외) 직원
function evalEligible() { return EMP.filter(e => e.pos !== '부장'); }

// 서버에서 평가 데이터를 1회 불러온다 (이후 메모리에 유지)
async function ensureEvaluations() {
  if (EVAL.loaded) return;
  try {
    const res = await apiRequest('/api/evaluations');
    const ev = res.evaluations || {};
    EVAL.ratios = { S: 0, A: 0, G: 0, C: 0, D: 0, ...(ev.ratios || {}) };
    EVAL.data = ev.evals || {};
    EVAL.mult = ev.mult || {};
    EVAL.awards = ev.awards || {};
    EVAL.confirmed = ev.confirmed || {};
    EVAL.loaded = true;
  } catch (_) {}
}

// 평가하기 진입 비밀번호 재확인 ───────────────
function openEvalAuth() {
  const modal = document.getElementById('eval-auth-modal');
  const input = document.getElementById('eval-auth-input');
  const err = document.getElementById('eval-auth-error');
  if (!modal || !input) { activateScreen('evaluate'); return; }
  if (err) err.textContent = '';
  input.value = '';
  modal.classList.add('show');
  setTimeout(() => input.focus(), 50);
}

function closeEvalAuth() {
  document.getElementById('eval-auth-modal')?.classList.remove('show');
}

// 입력한 비밀번호를 /api/login으로 재검증 → 통과 시에만 평가하기 화면 표시
async function submitEvalAuth() {
  const input = document.getElementById('eval-auth-input');
  const err = document.getElementById('eval-auth-error');
  const val = input?.value || '';
  if (!EMP_PASSWORD_RULE.test(val)) {
    if (err) err.textContent = '비밀번호는 4자 이상 입력해 주세요.';
    return;
  }
  try {
    await apiRequest('/api/login', { method: 'POST', body: JSON.stringify({ password: val }) });
  } catch (e) {
    if (err) err.textContent = e.message;
    input?.focus();
    return;
  }
  closeEvalAuth();
  activateScreen('evaluate');
}

function handleEvalAuthKey(el, ev) {
  if (ev.key === 'Enter') submitEvalAuth();
  if (ev.key === 'Escape') closeEvalAuth();
}

function renderEvaluate() {
  ensureEvaluations().then(() => {
    if (!EVAL.periodInit) { setDefaultEvalPeriod(); EVAL.periodInit = true; }
    renderEvalRatioGrid();
    renderEvalTeamFilter();
    renderEvalTable();
    updateEvalConfirmBar();
    markTodayPeriodHeader();
  });
}

// 오늘 날짜에 해당하는 연도/반기 헤더를 강조 (1~6월=상반기, 7~12월=하반기)
function markTodayPeriodHeader() {
  const y = String(TODAY.getFullYear());
  const key = `${y}-H${TODAY.getMonth() < 6 ? 1 : 2}`;
  document.querySelectorAll('#eval-table th[data-yr]').forEach(th =>
    th.classList.toggle('cur-period-hd', th.dataset.yr === y));
  document.querySelectorAll('#eval-table th[data-period]').forEach(th =>
    th.classList.toggle('cur-period-hd', th.dataset.period === key));
}

// 평가대상 연도/반기 기본값을 오늘 날짜에 맞춤 (1~6월=상반기, 7~12월=하반기)
function setDefaultEvalPeriod() {
  const yearSel = document.getElementById('eval-year');
  const halfSel = document.getElementById('eval-half');
  if (!yearSel || !halfSel) return;
  const y = String(TODAY.getFullYear());
  if ([...yearSel.options].some(o => o.value === y)) yearSel.value = y;
  halfSel.value = TODAY.getMonth() < 6 ? '1' : '2';
}

// 현재 헤더에서 선택된 평가대상 기간 (예: '2025-H1')
function activePeriodKey() {
  const y = document.getElementById('eval-year')?.value || '2025';
  const h = document.getElementById('eval-half')?.value || '1';
  return `${y}-H${h}`;
}
function activePeriodLabel() {
  const k = activePeriodKey();
  return EVAL_PERIODS.find(p => p.key === k)?.label || k;
}

// 등급별 목표 비율 입력 카드
function renderEvalRatioGrid() {
  const grid = document.getElementById('eval-ratio-grid');
  if (!grid) return;
  grid.innerHTML = EVAL_GRADES.map(g => `
    <div class="erg-item" style="border-color:${g.color}44">
      <span class="erg-badge" style="color:${g.color};background:${g.color}1f">${g.key}</span>
      <span class="erg-label">${g.label}</span>
      <input id="erg-${g.key}" class="erg-input" type="number" min="0" max="100" step="0.1"
        value="${EVAL.ratios[g.key] ?? 0}" data-input="evalRatioInput" data-grade="${g.key}">
      <span class="erg-pct">%</span>
      <span class="erg-alloc"><b id="erg-alloc-${g.key}">0</b>명 <span class="erg-calc" id="erg-calc-${g.key}">(0.0%)</span></span>
    </div>`).join('');
  const total = document.getElementById('eval-total');
  if (total) total.textContent = evalEligible().length;
  updateEvalRatioUI();
}

// 입력 비율로 등급별 정수 인원을 자동 배분 + 배분 결과의 실제(계산) 비율 표시
function updateEvalRatioUI() {
  const eligible = evalEligible().length;
  const ratios = {};
  let sum = 0;
  EVAL_GRADES.forEach(g => {
    const inp = document.getElementById('erg-' + g.key);
    let v = inp ? parseFloat(inp.value) : 0;
    if (!Number.isFinite(v) || v < 0) v = 0;
    ratios[g.key] = v;
    sum += v;
  });
  sum = Math.round(sum * 10) / 10;

  const alloc = evalAllocate(eligible, ratios);
  let allocTotal = 0;
  EVAL_GRADES.forEach(g => {
    const n = alloc[g.key] || 0;
    allocTotal += n;
    const aEl = document.getElementById('erg-alloc-' + g.key);
    if (aEl) aEl.textContent = n;
    const cEl = document.getElementById('erg-calc-' + g.key);
    if (cEl) cEl.textContent = `(${eligible ? (n / eligible * 100).toFixed(1) : '0.0'}%)`;
  });
  const atEl = document.getElementById('eval-alloc-total');
  if (atEl) atEl.textContent = allocTotal;

  const sumEl = document.getElementById('eval-ratio-sum');
  if (sumEl) {
    sumEl.textContent = sum.toFixed(1);
    const ok = Math.abs(sum - 100) < 0.05;
    sumEl.parentElement.classList.toggle('sum-ok', ok);
    sumEl.parentElement.classList.toggle('sum-bad', !ok);
  }
}

// 입력 중에는 합계만 갱신, 소수 2자리 이상은 한 자리로 보정
function onEvalRatioInput(el) {
  if (/\.\d{2,}/.test(el.value)) el.value = (Math.round(parseFloat(el.value) * 10) / 10).toString();
  updateEvalRatioUI();
}

// 입력 비율로 등급별 정수 인원수를 자동 배분
//  - 합계 100% → 최대잔여법으로 정확히 인원수에 맞춤(합 = 전체)
//  - 합계 ≠ 100% → 등급별 단순 반올림(참고용)
function evalAllocate(total, ratios) {
  const sum = Math.round(EVAL_GRADES.reduce((s, g) => s + (Number(ratios[g.key]) || 0), 0) * 10) / 10;
  if (Math.abs(sum - 100) < 0.05) return evalQuota(total, ratios);
  const a = {};
  EVAL_GRADES.forEach(g => { a[g.key] = Math.round(total * (Number(ratios[g.key]) || 0) / 100); });
  return a;
}

async function saveEvalRatios() {
  let sum = 0;
  const next = {};
  for (const g of EVAL_GRADES) {
    const inp = document.getElementById('erg-' + g.key);
    let v = inp ? parseFloat(inp.value) : 0;
    if (!Number.isFinite(v) || v < 0) v = 0;
    v = Math.round(v * 10) / 10;
    next[g.key] = v;
    sum += v;
  }
  sum = Math.round(sum * 10) / 10;
  if (Math.abs(sum - 100) >= 0.05) {
    alert(`등급별 비율의 합계가 100%가 되어야 합니다. (현재 ${sum.toFixed(1)}%)`);
    return;
  }
  EVAL.ratios = next;
  try {
    await persistEvaluations();
    updateEvalConfirmBar();
    flashEvalSaved('목표 비율이 저장되었습니다.');
  } catch (e) {
    alert(e.message);
  }
}

// 평가 테이블 ─────────────────────────
function renderEvalTeamFilter() {
  const sel = document.getElementById('eval-flt-team');
  if (!sel) return;
  const cur = sel.value || 'all';
  const teams = sortedTeams(EMP);
  sel.innerHTML = '<option value="all">전체 팀</option>' +
    teams.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value = teams.includes(cur) || cur === 'all' ? cur : 'all';
}

function evalFiltered() {
  const s = document.getElementById('eval-srch')?.value || '';
  const t = document.getElementById('eval-flt-team')?.value || 'all';
  return EMP.filter(e => {
    if (e.pos === '부장') return false; // 부장은 평가 대상에서 제외
    if (s && !e.name.includes(s) && !e.empNo.includes(s) && !e.team.includes(s)) return false;
    if (t !== 'all' && e.team !== t) return false;
    return true;
  });
}

// 평가기간 비교: 기준(오늘) 반기 이하만 입력 허용, 이후(미래) 반기는 잠금
function periodValue(key) { const [y, h] = key.split('-H'); return Number(y) * 2 + Number(h); }
function todayPeriodValue() { return TODAY.getFullYear() * 2 + (TODAY.getMonth() < 6 ? 1 : 2); }
function isLockedFuture(period) { return periodValue(period) > todayPeriodValue(); }
function periodLabel(period) { return EVAL_PERIODS.find(p => p.key === period)?.label || period; }

function evalSelClass(val, period) {
  return 'eval-sel' + (val ? ' g-' + val : '')
    + (period === activePeriodKey() ? ' active-period' : '')
    + (isLockedFuture(period) ? ' locked-future' : '');
}

function evalCell(empNo, period) {
  const cur = EVAL.data[empNo]?.[period] || '';
  const locked = !!EVAL.confirmed[period];
  const opts = ['<option value="">-</option>']
    .concat(EVAL_GRADES.map(g => `<option value="${g.key}"${g.key === cur ? ' selected' : ''}>${g.key} ${g.label}</option>`))
    .join('');
  return `<td class="c"><select class="${evalSelClass(cur, period)}"${locked ? ' disabled' : ''} data-change="setEvalGrade" data-keydown="evalCellKey" data-empno="${esc(empNo)}" data-period="${period}">${opts}</select></td>`;
}

// 배수횟수: 한 자리 숫자(0~9) 입력, 초기값 0
function evalMultCell(empNo) {
  const cur = EVAL.mult[empNo];
  const val = cur === undefined || cur === null ? 0 : cur;
  return `<input class="eval-mult" type="number" min="0" max="9" step="1" inputmode="numeric"
    value="${esc(val)}" data-input="setEvalMult" data-focusin="selectAll" data-empno="${esc(empNo)}">`;
}

function setEvalMult(el) {
  const empNo = el.dataset.empno;
  const digits = el.value.replace(/[^\d]/g, '');
  // 마지막에 입력한 한 자리 숫자를 사용 (기본값 0 뒤에 입력해 '03'이 되어도 '3'으로 처리)
  const v = digits ? digits.slice(-1) : '0';
  if (el.value !== v) el.value = v;
  EVAL.mult[empNo] = Number(v);
  scheduleEvalSave();
}

// (현직급)표창갯수: 0~99 정수, 초기값 0
function evalAwardCell(empNo) {
  const cur = EVAL.awards[empNo];
  const val = cur === undefined || cur === null ? 0 : cur;
  return `<input class="eval-mult eval-award" type="number" min="0" max="99" step="1" inputmode="numeric"
    value="${esc(val)}" data-input="setEvalAward" data-focusin="selectAll" data-empno="${esc(empNo)}">`;
}

function setEvalAward(el) {
  const empNo = el.dataset.empno;
  const digits = el.value.replace(/[^\d]/g, '').slice(0, 2); // 0~99
  const v = digits === '' ? '0' : String(Math.min(99, Number(digits)));
  if (el.value !== v) el.value = v;
  EVAL.awards[empNo] = Number(v);
  scheduleEvalSave();
}

function renderEvalTable() {
  const list = sortEmpList(evalFiltered());
  const cnt = document.getElementById('eval-count');
  if (cnt) cnt.textContent = list.length;
  const tbody = document.getElementById('eval-tbody');
  if (!tbody) return;
  tbody.innerHTML = list.map((e, i) => `
    <tr>
      <td class="c" style="color:#48484A">${i + 1}</td>
      <td style="color:#1C1C1E">${esc(e.team)}</td>
      <td><div style="display:flex;align-items:center;gap:7px">${av(e.name, 22)}<span style="color:#1C1C1E;font-weight:500">${esc(e.name)}</span></div></td>
      <td style="color:#48484A;font-size:11px">${esc(e.empNo)}</td>
      <td class="eval-pos" style="color:#1C1C1E" title="${esc(e.pos)}">${esc(e.pos)}</td>
      <td class="c">${gtag(e.grade)}</td>
      <td class="c">${evalAwardCell(e.empNo)}</td>
      <td class="c">${evalMultCell(e.empNo)}</td>
      ${EVAL_PERIODS.map(p => evalCell(e.empNo, p.key)).join('')}
    </tr>`).join('');
}

// 같은 기간(열)에서 현재 칸 기준 dir(+1 아래 / -1 위) 방향의 다음 입력 칸으로 포커스 이동
function moveEvalFocus(el, dir) {
  const sels = [...document.querySelectorAll(`#eval-tbody select[data-period="${el.dataset.period}"]`)];
  const i = sels.indexOf(el);
  for (let j = i + dir; j >= 0 && j < sels.length; j += dir) {
    if (!sels[j].disabled) { sels[j].focus(); break; }
  }
}

// 평가등급 칸 키보드 조작:
//  - S/A/G/C/D 영문자 → 해당 등급으로 직접 입력 (검증/저장)
//  - Enter → 같은 기간(열)의 다음(아래) 행으로 이동
//  - Shift+Tab → 같은 기간(열)의 이전(위) 행으로 이동
//  - 일반 Tab → 이동 차단 (확정/잠금된 칸은 건너뜀)
function evalCellKey(el, ev) {
  if (el.disabled) return;
  const up = ev.key.length === 1 ? ev.key.toUpperCase() : '';
  if (EVAL_GRADES.some(g => g.key === up)) {
    ev.preventDefault();              // 네이티브 타이프어헤드 억제 후 직접 반영
    if (el.value !== up) {
      el.value = up;
      setEvalGrade(el);               // 정원 검증 + 저장 (초과 시 자동 되돌림)
    }
    return;
  }
  if (ev.key === 'Tab') {
    ev.preventDefault();
    moveEvalFocus(el, ev.shiftKey ? -1 : +1); // Tab=아래, Shift+Tab=위
    return;
  }
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  moveEvalFocus(el, +1);
}

function setEvalGrade(el) {
  const empNo = el.dataset.empno;
  const period = el.dataset.period;
  const val = el.value;
  const prev = EVAL.data[empNo]?.[period] || '';

  // 확정된 기간은 수정 불가 (안전장치 — 평소엔 select가 disabled)
  if (EVAL.confirmed[period]) { el.value = prev; el.className = evalSelClass(prev, period); return; }

  // 기준(오늘) 반기 이후의 미래 기간은 등급 입력 불가 → 되돌리고 토스트 안내
  if (isLockedFuture(period)) {
    el.value = prev;
    el.className = evalSelClass(prev, period);
    showEvalToast(`${periodLabel(period)}은(는) 아직 평가 입력 기간이 아닙니다.`);
    return;
  }

  // 활성 평가대상 기간이면 등급별 목표 정원(quota) 초과 입력을 차단
  if (val && period === activePeriodKey()) {
    const v = evalValidate(period);
    if (v.quotaOk) {
      const after = v.counts[val] + (prev === val ? 0 : 1); // 이번 선택 반영 후 해당 등급 인원
      if (after > v.quota[val]) {
        el.value = prev;                       // 마지막 입력 되돌림(선택 해제/이전값)
        el.className = evalSelClass(prev, period);
        const g = evalGrade(val);
        showEvalModal('등급 인원 초과',
          `${val}(${g.label}) 등급의 목표 인원 ${v.quota[val]}명을 모두 채웠습니다.\n목표 비율을 초과하여 선택할 수 없습니다.`);
        return;
      }
    }
  }

  if (!EVAL.data[empNo]) EVAL.data[empNo] = {};
  if (val) EVAL.data[empNo][period] = val;
  else delete EVAL.data[empNo][period];
  if (!Object.keys(EVAL.data[empNo]).length) delete EVAL.data[empNo];
  el.className = evalSelClass(val, period);
  scheduleEvalSave();
  updateEvalConfirmBar();
}

// ── 비율 대비 등급 입력 검증 ──
// 목표 비율을 평가대상 인원에 최대잔여법으로 정수 배분 → 등급별 정원(quota)
function evalQuota(total, ratios = EVAL.ratios) {
  const parts = EVAL_GRADES.map(g => {
    const exact = total * (Number(ratios[g.key]) || 0) / 100;
    return { key: g.key, floor: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let left = total - parts.reduce((s, p) => s + p.floor, 0);
  // 잔여 인원은 소수부가 큰 등급부터 1명씩 배정
  parts.slice().sort((a, b) => b.rem - a.rem).forEach(p => { if (left > 0) { p.floor++; left--; } });
  const q = {};
  parts.forEach(p => { q[p.key] = p.floor; });
  return q;
}

function evalValidate(period) {
  const eligible = evalEligible();
  const counts = { S: 0, A: 0, G: 0, C: 0, D: 0 };
  eligible.forEach(e => { const g = EVAL.data[e.empNo]?.[period]; if (g && counts[g] !== undefined) counts[g]++; });
  const sum = Math.round(EVAL_GRADES.reduce((s, g) => s + (EVAL.ratios[g.key] || 0), 0) * 10) / 10;
  const quotaOk = Math.abs(sum - 100) < 0.05;
  const quota = evalQuota(eligible.length);
  const assigned = EVAL_GRADES.reduce((s, g) => s + counts[g.key], 0);
  let over = null, exact = true;
  EVAL_GRADES.forEach(g => {
    if (counts[g.key] > quota[g.key]) over = g.key;
    if (counts[g.key] !== quota[g.key]) exact = false;
  });
  const match = quotaOk && assigned === eligible.length && exact && !over;
  return { eligible: eligible.length, counts, quota, quotaOk, assigned, over, match };
}

function updateEvalConfirmBar() {
  const period = activePeriodKey();
  const confirmed = !!EVAL.confirmed[period];
  const v = evalValidate(period);
  const statusEl = document.getElementById('eval-confirm-status');
  const btn = document.getElementById('eval-confirm-btn');
  if (statusEl) {
    if (confirmed) {
      statusEl.innerHTML = `<span class="ecf-ok">✓ ${esc(activePeriodLabel())} 확정 완료</span>`;
    } else if (!v.quotaOk) {
      statusEl.innerHTML = `<span class="ecf-warn">목표 비율 합계를 100%로 저장하세요</span>`;
    } else if (v.match) {
      statusEl.innerHTML = `<span class="ecf-ok">목표 비율과 일치 — 확정 가능</span>`;
    } else {
      const remain = v.eligible - v.assigned;
      const detail = EVAL_GRADES.map(g => {
        const c = v.counts[g.key], q = v.quota[g.key];
        return `<span class="${c === q ? 'ecf-g-ok' : 'ecf-g-no'}">${g.key} ${c}/${q}</span>`;
      }).join('');
      statusEl.innerHTML = `<span class="ecf-warn">${remain > 0 ? `미입력 ${remain}명` : '비율 불일치'}</span><span class="ecf-detail">${detail}</span>`;
    }
  }
  if (btn) {
    btn.textContent = confirmed ? '확정 취소' : '확정하기';
    btn.classList.toggle('confirmed', confirmed);
    btn.classList.toggle('ready', !confirmed && v.match);
    btn.disabled = false; // 항상 클릭 가능 — 불일치 시 클릭하면 오류 모달로 안내
  }
}

function onEvalPeriodChange() {
  renderEvalTable();        // 활성 기간 강조 / 잠금 상태 갱신
  updateEvalConfirmBar();
}

function confirmEvalPeriod() {
  const period = activePeriodKey();
  const label = activePeriodLabel();
  const wasConfirmed = !!EVAL.confirmed[period];
  if (wasConfirmed) {
    if (!confirm(`${label} 확정을 취소하시겠습니까?\n취소하면 해당 기간을 다시 수정할 수 있습니다.`)) return;
    delete EVAL.confirmed[period];
  } else {
    const v = evalValidate(period);
    if (!v.match) {
      showEvalModal('확정할 수 없습니다',
        `${label} 평가를 확정하려면 아래 항목을 먼저 해결해 주세요.`, evalConfirmErrors(v));
      return;
    }
    if (!confirm(`${label} 평가를 최종 확정하시겠습니까?\n확정 후에는 해당 기간 등급이 잠깁니다.`)) return;
    EVAL.confirmed[period] = true;
  }
  persistEvaluations()
    .then(() => { renderEvalTable(); updateEvalConfirmBar(); flashEvalSaved(wasConfirmed ? '확정 취소됨' : '확정 완료'); })
    .catch(e => {
      if (wasConfirmed) EVAL.confirmed[period] = true; else delete EVAL.confirmed[period]; // 저장 실패 시 원복
      alert(e.message);
    });
}

// 확정 불가 사유 목록 생성 (목표 비율 미설정 / 미입력 / 등급별 인원 초과·부족)
function evalConfirmErrors(v) {
  if (!v.quotaOk) return ['목표 비율 합계가 100%가 아닙니다. 먼저 목표 비율을 100%로 설정·저장해 주세요.'];
  const errs = [];
  const remain = v.eligible - v.assigned;
  if (remain > 0) errs.push(`미입력 인원이 ${remain}명 있습니다. (입력 ${v.assigned}명 / 전체 ${v.eligible}명)`);
  EVAL_GRADES.forEach(g => {
    const c = v.counts[g.key], q = v.quota[g.key];
    if (c !== q) errs.push(`${g.key}(${g.label}) 등급: 입력 ${c}명 · 목표 ${q}명 — ${c > q ? `${c - q}명 초과` : `${q - c}명 부족`}`);
  });
  return errs;
}

// items가 있으면 목록(ul)으로, 없으면 단순 메시지로 표시
function showEvalModal(title, msg, items) {
  const t = document.getElementById('eval-modal-title');
  const m = document.getElementById('eval-modal-msg');
  if (t) t.textContent = title;
  if (m) {
    if (Array.isArray(items) && items.length) {
      m.innerHTML = `${msg ? `<div style="margin-bottom:9px">${esc(msg)}</div>` : ''}` +
        `<ul class="eval-err-list">${items.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
    } else {
      m.textContent = msg;
    }
  }
  document.getElementById('eval-modal')?.classList.add('show');
}
function closeEvalModal() { document.getElementById('eval-modal')?.classList.remove('show'); }

// 평가 등급 입력은 빠르게 연속될 수 있어 디바운스 저장
let evalSaveTimer = null;
function scheduleEvalSave() {
  clearTimeout(evalSaveTimer);
  evalSaveTimer = setTimeout(() => {
    persistEvaluations().then(() => flashEvalSaved('저장됨')).catch(e => alert(e.message));
  }, 450);
}

async function persistEvaluations() {
  await apiRequest('/api/evaluations', {
    method: 'PUT',
    body: JSON.stringify({ ratios: EVAL.ratios, evals: EVAL.data, mult: EVAL.mult, awards: EVAL.awards, confirmed: EVAL.confirmed }),
  });
}

let evalFlashTimer = null;
function flashEvalSaved(msg) {
  const el = document.getElementById('eval-save-state');
  if (!el) return;
  el.textContent = '✓ ' + msg;
  el.classList.add('show');
  clearTimeout(evalFlashTimer);
  evalFlashTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// 화면 하단 토스트 메시지 (입력 불가 등 일시 안내)
let evalToastTimer = null;
function showEvalToast(msg) {
  let el = document.getElementById('eval-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'eval-toast';
    el.className = 'eval-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(evalToastTimer);
  evalToastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── 평가 CSV 내보내기 / 가져오기 / 템플릿 ──
// 헤더명 → 평가기간 키 매핑 (csvRow/parseCSV/triggerDownload는 직원목록 함수 재사용)
const EVAL_CSV_PERIOD = {
  '2025상반기': '2025-H1', '2025하반기': '2025-H2',
  '2026상반기': '2026-H1', '2026하반기': '2026-H2',
  '2027상반기': '2027-H1', '2027하반기': '2027-H2',
};
const EVAL_CSV_HEADERS = ['팀', '성명', '직원번호', '직위', '직급', '(현직급)표창갯수', '배수횟수', ...Object.keys(EVAL_CSV_PERIOD)];

function exportEvalCSV() {
  const list = sortEmpList(evalFiltered());
  const rows = list.map(e => csvRow([
    e.team, e.name, e.empNo, e.pos, e.grade, EVAL.awards[e.empNo] ?? 0, EVAL.mult[e.empNo] ?? 0,
    ...EVAL_PERIODS.map(p => EVAL.data[e.empNo]?.[p.key] || ''),
  ]));
  triggerDownload([csvRow(EVAL_CSV_HEADERS), ...rows].join('\n'), 'EIMS_평가.csv');
}

function downloadEvalTemplate() {
  const ex = ['여신심사팀', '홍길동', '1234567', '팀원', 'L2', 2, 3, 'S', 'A', '', '', '', ''];
  triggerDownload([csvRow(EVAL_CSV_HEADERS), csvRow(ex)].join('\n'), 'EIMS_평가_템플릿.csv');
}

// 직원번호로 매칭하여 등급/배수횟수를 반영. 확정(잠금)된 기간은 보호하고 건너뛴다.
function importEvalCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    let text = ev.target.result;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = parseCSV(text).filter(r => r.some(c => c.trim() !== ''));
    input.value = '';
    if (rows.length < 2) { alert('데이터가 없습니다.'); return; }
    const hdr = rows[0].map(h => h.trim());
    const empNoIdx = hdr.indexOf('직원번호');
    const multIdx = hdr.indexOf('배수횟수');
    const awardIdx = hdr.indexOf('(현직급)표창갯수');
    if (empNoIdx < 0) { alert('CSV에 "직원번호" 열이 필요합니다.'); return; }
    const periodIdx = {};
    hdr.forEach((h, i) => { if (EVAL_CSV_PERIOD[h]) periodIdx[EVAL_CSV_PERIOD[h]] = i; });

    const known = new Set(EMP.map(e => e.empNo));
    let applied = 0, unknown = 0, lockedHit = false, badGrade = 0;
    rows.slice(1).forEach(vals => {
      const empNo = (vals[empNoIdx] || '').trim();
      if (!empNo) return;
      if (!known.has(empNo)) { unknown++; return; }
      if (multIdx >= 0) {
        const m = (vals[multIdx] || '').replace(/[^\d]/g, '').slice(-1);
        EVAL.mult[empNo] = m === '' ? 0 : Number(m);
      }
      if (awardIdx >= 0) {
        const a = (vals[awardIdx] || '').replace(/[^\d]/g, '').slice(0, 2);
        EVAL.awards[empNo] = a === '' ? 0 : Math.min(99, Number(a));
      }
      Object.entries(periodIdx).forEach(([pk, ci]) => {
        if (EVAL.confirmed[pk]) { lockedHit = true; return; } // 확정 기간 보호
        const g = (vals[ci] || '').trim().toUpperCase();
        if (g === '') { if (EVAL.data[empNo]) delete EVAL.data[empNo][pk]; return; }
        if (!EVAL_GRADES.some(x => x.key === g)) { badGrade++; return; }
        if (!EVAL.data[empNo]) EVAL.data[empNo] = {};
        EVAL.data[empNo][pk] = g;
      });
      if (EVAL.data[empNo] && !Object.keys(EVAL.data[empNo]).length) delete EVAL.data[empNo];
      applied++;
    });

    try {
      await persistEvaluations();
      EVAL.loaded = true;
      renderEvalRatioGrid();
      renderEvalTable();
      updateEvalConfirmBar();
      let msg = `${applied}명의 평가 데이터를 반영했습니다.`;
      if (unknown) msg += `\n· 매칭되지 않은 직원번호 ${unknown}건은 건너뜀`;
      if (badGrade) msg += `\n· 허용되지 않은 등급값 ${badGrade}건은 건너뜀 (S/A/G/C/D만 가능)`;
      if (lockedHit) msg += `\n· 확정된 기간은 보호되어 일부 값이 적용되지 않았습니다`;
      alert(msg);
    } catch (e) {
      alert(e.message);
    }
  };
  reader.readAsText(file, 'utf-8');
}

// ═══════════════════════════════════════
//  CHARTS
// ═══════════════════════════════════════
const TK = { color: '#48484A', font: { family: "'Noto Sans KR',sans-serif", size: 10 } };
const BS = {
  x: { grid: { color: 'rgba(0,0,0,.06)' }, ticks: TK, border: { color: 'transparent' } },
  y: { grid: { color: 'rgba(0,0,0,.06)' }, ticks: TK, border: { color: 'transparent' } },
};

// 인라인 데이터 레이블 플러그인 (외부 라이브러리 불필요)
const DL = {
  id: 'dl',
  afterDatasetsDraw(chart, args, pluginOpts) {
    const { ctx } = chart;
    const isHoriz   = chart.options.indexAxis === 'y';
    const isStacked = !!chart.options.scales?.y?.stacked;
    const fmt = pluginOpts?.formatter;
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      meta.data.forEach((el, j) => {
        const raw = ds.data[j];
        if (raw == null || raw === 0) return;
        const val = fmt ? fmt(raw, chart, i, j) : raw;

        // 도넛/파이: ArcElement는 startAngle 속성 보유
        if (el.startAngle !== undefined) {
          const mid = (el.startAngle + el.endAngle) / 2;
          const r   = (el.innerRadius + el.outerRadius) / 2;
          if (Math.abs(el.endAngle - el.startAngle) * r < 18) return;
          ctx.save();
          ctx.font = 'bold 11px "Noto Sans KR",sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,.92)';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(val, el.x + r * Math.cos(mid), el.y + r * Math.sin(mid));
          ctx.restore();
          return;
        }

        // 꺾은선: 포인트 위에 표시
        if (meta.type === 'line') {
          ctx.save();
          ctx.font = '600 9px "Noto Sans KR",sans-serif';
          ctx.fillStyle = '#FFBC00';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(val, el.x, el.y - 5);
          ctx.restore();
          return;
        }

        // 막대
        const props = el.getProps(['x', 'y', 'base'], true);
        const barLen = isHoriz
          ? Math.abs(props.x - props.base)
          : Math.abs(props.y - props.base);
        ctx.save();
        ctx.font = 'bold 10px "Noto Sans KR",sans-serif';
        ctx.fillStyle = '#1C1C1E';
        ctx.textAlign = 'center';
        if (isStacked) {
          if (barLen < 14) { ctx.restore(); return; }
          ctx.textBaseline = 'middle';
          ctx.fillText(val,
            isHoriz ? (props.x + props.base) / 2 : props.x,
            isHoriz ? props.y : (props.y + props.base) / 2
          );
        } else if (isHoriz) {
          if (barLen < 20) { ctx.restore(); return; }
          ctx.textBaseline = 'middle';
          ctx.fillText(val, (props.x + props.base) / 2, props.y);
        } else {
          ctx.textBaseline = 'bottom';
          ctx.fillText(val, props.x, Math.min(props.y, props.base) - 2);
        }
        ctx.restore();
      });
    });
  }
};

function initCharts() {
  const C = window.Chart;
  if (!C) return;
  const sc = S.screen;

  if (sc === 'dashboard') {
    const dC = {};
    sortedTeams(EMP).forEach(t => { dC[t] = EMP.filter(e => e.team === t).length; });

    const e1 = document.getElementById('c-dept');
    if (e1 && !charts.dept) {
      charts.dept = new C(e1, {
        type: 'bar',
        data: { labels: Object.keys(dC), datasets: [{ data: Object.values(dC), backgroundColor: Object.keys(dC).map((_, i) => DASH_TEAM_COLORS[i % DASH_TEAM_COLORS.length]), borderWidth: 0, borderRadius: 5 }] },
        options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: BS.x, y: { ...BS.y, grid: { display: false } } } },
        plugins: [DL],
      });
    }

    const gC = {};
    EMP.forEach(e => { gC[e.grade] = (gC[e.grade] || 0) + 1; });
    const e2 = document.getElementById('c-grade');
    if (e2 && !charts.grade) {
      charts.grade = new C(e2, {
        type: 'doughnut',
        data: { labels: Object.keys(gC), datasets: [{ data: Object.values(gC), backgroundColor: Object.keys(gC).map(dashGradeColor), borderWidth: 0 }] },
        plugins: [DL],
        options: { responsive: true, maintainAspectRatio: false, cutout: '66%', plugins: { legend: { position: 'right', labels: { generateLabels(chart) { const d = chart.data; return d.labels.map((lbl, i) => ({ text: `${lbl}  ${d.datasets[0].data[i]}명`, fillStyle: d.datasets[0].backgroundColor[i], strokeStyle: 'transparent', lineWidth: 0, hidden: false, index: i, fontColor: '#3A3A3C' })); }, color: '#3A3A3C', font: { family: "'Noto Sans KR',sans-serif", size: 10 }, padding: 10, boxWidth: 10 } } } },
      });
    }

    const mc = EMP.filter(e => e.gender === '남').length;
    const e3 = document.getElementById('c-gender');
    if (e3 && !charts.gender) {
      charts.gender = new C(e3, {
        type: 'doughnut',
        data: { labels: ['남성', '여성'], datasets: [{ data: [mc, EMP.length - mc], backgroundColor: ['#5B9BD5', '#E84D8A'], borderWidth: 0 }] },
        plugins: [DL],
        options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { generateLabels(chart) { const d = chart.data; return d.labels.map((lbl, i) => ({ text: `${lbl}  ${d.datasets[0].data[i]}명 (${EMP.length ? Math.round(d.datasets[0].data[i]/EMP.length*100) : 0}%)`, fillStyle: d.datasets[0].backgroundColor[i], strokeStyle: 'transparent', lineWidth: 0, hidden: false, index: i, fontColor: '#3A3A3C' })); }, color: '#3A3A3C', font: { family: "'Noto Sans KR',sans-serif", size: 10 }, padding: 14, boxWidth: 10 } } } },
      });
    }

    const jy = {};
    EMP.forEach(e => { const y = e.joinDate.slice(0, 4); jy[y] = (jy[y] || 0) + 1; });
    const ys = Object.keys(jy).sort();
    const e4 = document.getElementById('c-join');
    if (e4 && !charts.join) {
      charts.join = new C(e4, {
        type: 'line',
        data: { labels: ys, datasets: [{ data: ys.map(y => jy[y]), borderColor: '#FFBC00', backgroundColor: 'rgba(255,188,0,.05)', pointBackgroundColor: '#FFBC00', pointBorderColor: '#1A1A24', pointRadius: 3, tension: .4, fill: true, borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 18 } }, plugins: { legend: { display: false } }, scales: BS },
        plugins: [DL],
      });
    }
  }

  if (sc === 'stats') {
    const teams = sortedTeams(EMP);
    const el = document.getElementById('c-dept-detail');
    if (el && !charts.dd) {
      const grades = ['L1', 'L2', 'L3', 'L4'];
      const colors = grades.map(dashGradeColor);
      charts.dd = new C(el, {
        type: 'bar',
        data: {
          labels: teams,
          datasets: grades.map((g, i) => ({
            label: g, backgroundColor: colors[i], borderWidth: 0, borderRadius: 2,
            data: teams.map(t => EMP.filter(e => e.team === t && e.grade === g).length),
          })),
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: '#48484A', font: { family: "'Noto Sans KR',sans-serif", size: 10 }, padding: 14, boxWidth: 12 } },
            dl: { formatter: (v, chart, di, ji) => {
              const total = chart.data.datasets.reduce((s, d) => s + (d.data[ji] || 0), 0);
              return total ? `${v} (${Math.round(v/total*100)}%)` : `${v}`;
            }},
          },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: TK, border: { color: 'transparent' } },
            y: { stacked: true, ...BS.y },
          },
        },
        plugins: [DL],
      });
    }
  }

  if (sc === 'stats') {
    const ab = { '30대': 0, '40대': 0, '50대': 0, '60대+': 0 };
    EMP.forEach(e => {
      const a = calcAge(e.birthYear);
      if (a < 40)      ab['30대']++;
      else if (a < 50) ab['40대']++;
      else if (a < 60) ab['50대']++;
      else             ab['60대+']++;
    });
    const e5 = document.getElementById('c-age');
    if (e5 && !charts.age) {
      const pctFmt = (v) => { const n = EMP.length; return n ? `${v}명 (${Math.round(v/n*100)}%)` : `${v}명`; };
      charts.age = new C(e5, {
        type: 'bar',
        data: { labels: Object.keys(ab), datasets: [{ data: Object.values(ab), backgroundColor: ['#4E82C2', '#4EAF72', '#FFBC00', '#E63946'], borderWidth: 0, borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 18 } }, plugins: { legend: { display: false }, dl: { formatter: pctFmt } }, scales: BS },
        plugins: [DL],
      });
    }

    const tb = { '5년 미만': 0, '5~10년': 0, '10~15년': 0, '15~20년': 0, '20년+': 0 };
    EMP.forEach(e => {
      const y = (TODAY - new Date(e.joinDate)) / (365.25 * 24 * 3600 * 1000);
      if (y < 5)       tb['5년 미만']++;
      else if (y < 10) tb['5~10년']++;
      else if (y < 15) tb['10~15년']++;
      else if (y < 20) tb['15~20년']++;
      else             tb['20년+']++;
    });
    const e6 = document.getElementById('c-tenure');
    if (e6 && !charts.tenure) {
      const pctFmt = (v) => { const n = EMP.length; return n ? `${v}명 (${Math.round(v/n*100)}%)` : `${v}명`; };
      charts.tenure = new C(e6, {
        type: 'bar',
        data: { labels: Object.keys(tb), datasets: [{ data: Object.values(tb), backgroundColor: ['#4E82C2', '#4EAF72', '#FFBC00', '#F46600', '#E63946'], borderWidth: 0, borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 18 } }, plugins: { legend: { display: false }, dl: { formatter: pctFmt } }, scales: BS },
        plugins: [DL],
      });
    }

    const lv = {};
    EMP.forEach(e => { const l = '' + e.gradeLevel; lv[l] = (lv[l] || 0) + 1; });
    const lk = Object.keys(lv).sort((a, b) => parseInt(b) - parseInt(a));
    const e7 = document.getElementById('c-level');
    if (e7 && !charts.level) {
      const lc = ['#0066FF', '#E63946', '#F9A825', '#8080A0', '#7C4DFF'];
      const pctFmt = (v) => { const n = EMP.length; return n ? `${v}명 (${Math.round(v/n*100)}%)` : `${v}명`; };
      charts.level = new C(e7, {
        type: 'bar',
        data: { labels: lk, datasets: [{ data: lk.map(l => lv[l]), backgroundColor: lk.map((_, i) => lc[i % lc.length]), borderWidth: 0, borderRadius: 4 }] },
        options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 18 } }, plugins: { legend: { display: false }, dl: { formatter: pctFmt } }, scales: BS },
        plugins: [DL],
      });
    }
  }
}

// ═══════════════════════════════════════
//  CSV 내보내기 / 가져오기 / 템플릿
// ═══════════════════════════════════════
const CSV_HEADERS = ['No','부서','팀','성명','직원번호','직위','직급','호칭','입행일','출생년도','생년월일','성별','현직급승격일','등급','현등급책정일','차기등급일','입행전학교명','입행전전공','입행후학교명','입행후전공','기타'];
const CSV_FIELDS  = ['no','dept','team','name','empNo','pos','grade','title','joinDate','birthYear','birth','gender','gradeUpDate','gradeLevel','gradeSetDate','gradeNextDate','preSchool','preMajor','postSchool','postMajor','etc'];

function csvRow(vals) {
  return vals.map(v => {
    let s = String(v ?? '');
    // CSV 수식 인젝션 방지: =,+,-,@,탭,캐리지리턴으로 시작하면 무력화
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  }).join(',');
}

function triggerDownload(content, filename) {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCSV() {
  const rows = sortEmpList(EMP).map((e, i) => csvRow(CSV_FIELDS.map(f => f === 'no' ? i + 1 : e[f])));
  triggerDownload([csvRow(CSV_HEADERS), ...rows].join('\n'), 'EIMS_직원목록.csv');
}

function downloadTemplate() {
  const ex = [1,'여신IT개발부','여신심사팀','홍길동','1234567','팀원','L2','차장','2010-03-01',1980,'1980-05-20','남','2020-01-01',8,'2022-03-01','2025-03-01','서울대학교','컴퓨터공학','','',''];
  triggerDownload([csvRow(CSV_HEADERS), csvRow(ex)].join('\n'), 'EIMS_직원데이터_템플릿.csv');
}

// RFC 4180 파서: 따옴표 필드 내 쉼표/줄바꿈, escaped quote("")를 보존하며 전체를 행 단위로 토큰화
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // "" -> 리터럴 "
        else inQ = false;
      } else field += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch; // 따옴표 밖 \r(즉 \r\n)은 무시
    }
  }
  row.push(field); rows.push(row);
  return rows;
}

function importCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    let text = ev.target.result;
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = parseCSV(text).filter(r => r.some(c => c.trim() !== ''));
    if (rows.length < 2) { alert('데이터가 없습니다.'); return; }
    const hdrs = rows[0].map(h => h.trim());
    const colMap = {};
    CSV_HEADERS.forEach((h, i) => { colMap[h] = CSV_FIELDS[i]; });
    const imported = rows.slice(1).map((vals, i) => {
      const obj = {};
      hdrs.forEach((h, j) => { const key = colMap[h]; if (key) obj[key] = vals[j] !== undefined ? vals[j].trim() : ''; });
      obj.no = parseInt(obj.no) || (i + 1);
      obj.birthYear = parseInt(obj.birthYear) || 0;
      obj.gradeLevel = parseInt(obj.gradeLevel) || 1;
      return obj;
    }).filter(o => o.name);
    input.value = '';
    if (!imported.length) { alert('가져올 데이터가 없습니다.'); return; }
    const replace = confirm(`${imported.length}명의 데이터를 불러왔습니다.\n\n[확인] 기존 데이터를 새 데이터로 교체\n[취소] 기존 데이터에 추가`);
    try {
      const data = await apiRequest('/api/employees/import', {
        method: 'POST',
        body: JSON.stringify({ employees: imported, replace }),
      });
      EMP = data.employees || [];
      refreshViews();
      activateScreen('emplist');
    } catch (e) {
      alert(e.message);
    }
  };
  reader.readAsText(file, 'utf-8');
}

// ═══════════════════════════════════════
//  EVENT DELEGATION (CSP: 인라인 핸들러 제거 → script-src 'self')
// ═══════════════════════════════════════
const ACTIONS = {
  navigate: el => navigate(el.dataset.screen || el.dataset.arg),
  filter: () => renderEmpList(),
  openAdd: () => openAdd(),
  toggleEduCols: () => toggleEduCols(),
  downloadTemplate: () => downloadTemplate(),
  exportCSV: () => exportCSV(),
  importCSV: el => importCSV(el),
  openDetail: el => openDetail(el.dataset.empno),
  openEditFromList: (el, ev) => openEditFromList(el.dataset.empno, ev),
  deleteEmployee: (el, ev) => deleteEmployee(el.dataset.empno, ev),
  openEdit: () => openEdit(),
  cancelEdit: () => cancelEdit(),
  saveEmployeeForm: () => saveEmployeeForm(),
  closePasswordGate: () => closePasswordGate(),
  submitPasswordGate: () => submitPasswordGate(),
  handlePasswordKey: (el, ev) => handlePasswordKey(ev),
  openChangePw: () => openChangePw(),
  closeChangePw: () => closeChangePw(),
  submitChangePw: () => submitChangePw(),
  handleChangePwKey: (el, ev) => handleChangePwKey(el, ev),
  logout: () => doLogout(),
  sortBy: el => toggleSort(el.dataset.sort),
  evalFilter: () => renderEvalTable(),
  evalRatioInput: el => onEvalRatioInput(el),
  saveEvalRatios: () => saveEvalRatios(),
  setEvalGrade: el => setEvalGrade(el),
  setEvalMult: el => setEvalMult(el),
  setEvalAward: el => setEvalAward(el),
  selectAll: el => el.select?.(),
  evalCellKey: (el, ev) => evalCellKey(el, ev),
  evalPeriodChange: () => onEvalPeriodChange(),
  confirmEvalPeriod: () => confirmEvalPeriod(),
  closeEvalModal: () => closeEvalModal(),
  submitEvalAuth: () => submitEvalAuth(),
  closeEvalAuth: () => closeEvalAuth(),
  handleEvalAuthKey: (el, ev) => handleEvalAuthKey(el, ev),
  exportEvalCSV: () => exportEvalCSV(),
  downloadEvalTemplate: () => downloadEvalTemplate(),
  importEvalCSV: el => importEvalCSV(el),
};

function delegate(type) {
  return ev => {
    const el = ev.target.closest(`[data-${type}]`);
    if (!el) return;
    const fn = ACTIONS[el.dataset[type]];
    if (fn) fn(el, ev);
  };
}

['click', 'dblclick', 'change', 'input', 'keydown', 'focusin'].forEach(type => {
  document.addEventListener(type, delegate(type));
});

// ═══════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // sessionStorage는 새로고침엔 유지되고 탭/브라우저 종료 시 지워진다.
    // → 같은 세션에서의 새로고침일 때만(continued) 서버 세션을 확인해 로그인 유지.
    //   종료 후 재진입이면 continued가 없어 잠금 화면을 띄운다.
    if (sessionStorage.getItem('eims_auth') === '1') {
      const session = await apiRequest('/api/session');
      if (session.authenticated) {
        S.authenticated = true;
        resetIdleTimer();
        await loadEmployees();
        activateScreen('dashboard');
        return;
      }
    }
    sessionStorage.removeItem('eims_auth');
  } catch (_) {}
  openPasswordGate();
});

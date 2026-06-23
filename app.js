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
const PROTECTED_SCREENS = new Set(['dashboard', 'emplist', 'stats', 'detail']);

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
  const titles = { dashboard: '대시보드', emplist: '직원 목록', stats: '통계 분석', detail: '직원 상세' };
  const pt = document.getElementById('page-title');
  if (pt) pt.textContent = titles[screen] || screen;
  if (screen === 'dashboard') { renderHeader(); renderDept(); }
  if (screen === 'emplist') { sortState = []; renderEmpList(); }
  if (screen === 'detail') renderDetail();
  if (screen === 'stats')  { renderHeader(); renderStatLists(); ['age','tenure','level','dd'].forEach(k => { charts[k]?.destroy?.(); delete charts[k]; }); }
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

function doFilter() { renderEmpList(); }

// ═══════════════════════════════════════
//  STATS LISTS
// ═══════════════════════════════════════
const RETIRE_AGE = 55;
const RETIRE_NEAR = 2;

function renderStatLists() {
  const threeYearsAgo = new Date(TODAY.getFullYear() - 3, TODAY.getMonth(), TODAY.getDate());

  const retireList = EMP
    .filter(e => calcAge(e.birthYear, e.birth) >= RETIRE_AGE - RETIRE_NEAR)
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
  if (retire) retire.textContent = EMP.filter(e => calcAge(e.birthYear, e.birth) >= 53).length + '명';

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
      <td class="row-actions">
        <div class="row-actions-inner">
          <button class="row-act edit" data-click="openEditFromList" data-empno="${esc(e.empNo)}" title="직원정보 수정">수정</button>
          <button class="row-act del" data-click="deleteEmployee" data-empno="${esc(e.empNo)}" title="직원 삭제">삭제</button>
        </div>
      </td>
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
      <div class="det-row"><span class="det-lbl">특이사항</span><span class="det-val">${esc(emp.etc) || '-'}</span></div>
      <div class="det-acts">
        <button class="act-btn p" data-click="openEdit">정보 수정</button>
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
            <div style="font-size:10px;color:#636366;margin-top:2px">${esc(dept)}</div>
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
  filter: () => doFilter(),
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
};

function delegate(type) {
  return ev => {
    const el = ev.target.closest(`[data-${type}]`);
    if (!el) return;
    const fn = ACTIONS[el.dataset[type]];
    if (fn) fn(el, ev);
  };
}

['click', 'dblclick', 'change', 'input', 'keydown'].forEach(type => {
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

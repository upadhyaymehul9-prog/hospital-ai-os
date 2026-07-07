/**
 * AccredReady Real Agent — fetch-based Supabase client (no CDN dependency)
 */
const SUPABASE_URL = 'https://tbptllgcjtiiqspxqcde.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRicHRsbGdjanRpaXFzcHhxY2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2NjkzNjAsImV4cCI6MjA5MjI0NTM2MH0.4CPgNp6ytVNRmTU0FJbu2io94QJmsAow5im-vGtoRAU';

let api = null;
let agentCtx = null;
let pendingActions = [];
let onActionUpdate = null;
let onLog = null;

const WRITE_TOOLS = new Set([
  'update_oe_score', 'create_capa', 'add_committee_meeting', 'add_calendar_item'
]);

const AGENT_TOOLS = [
  { type: 'function', function: { name: 'get_hospital_summary', description: 'Get hospital name, plan, NABH status, assessment name, and score statistics.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_compliance_status', description: 'Get NABH compliance verdict via get_final_decision.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'get_active_gaps', description: 'List active compliance gaps.', parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_low_scored_oes', description: 'List OEs scored 2 or below.', parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_expiring_licenses', description: 'List licenses expiring within N days.', parameters: { type: 'object', properties: { days: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_kpi_status', description: 'Get KPI entries for month/year.', parameters: { type: 'object', properties: { month: { type: 'number' }, year: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'get_recent_audits', description: 'Get recent audit records.', parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] } } },
  { type: 'function', function: { name: 'update_oe_score', description: 'Score an OE 1-5. Requires user approval.', parameters: { type: 'object', properties: { oe_id: { type: 'string' }, score: { type: 'number' } }, required: ['oe_id', 'score'] } } },
  { type: 'function', function: { name: 'create_capa', description: 'Create CAPA. Requires user approval.', parameters: { type: 'object', properties: { oe_id: { type: 'string' }, finding: { type: 'string' }, action_planned: { type: 'string' }, responsible_person: { type: 'string' }, target_date: { type: 'string' } }, required: ['oe_id', 'finding', 'action_planned'] } } },
  { type: 'function', function: { name: 'add_committee_meeting', description: 'Schedule committee meeting. Requires approval.', parameters: { type: 'object', properties: { committee_id: { type: 'number' }, meeting_date: { type: 'string' }, chairperson: { type: 'string' }, venue: { type: 'string' } }, required: ['committee_id', 'meeting_date'] } } },
  { type: 'function', function: { name: 'add_calendar_item', description: 'Add calendar item. Requires approval.', parameters: { type: 'object', properties: { item_type: { type: 'string', enum: ['committee', 'drill'] }, item_id: { type: 'number' }, planned_date: { type: 'string' } }, required: ['item_type', 'item_id', 'planned_date'] } } }
];

function createApi() {
  return {
    token: localStorage.getItem('ar_token') || SUPABASE_ANON,
    hdrs(extra = {}) {
      return {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON,
        Authorization: `Bearer ${this.token}`,
        ...extra
      };
    },
    async login(email, password) {
      let resp;
      try {
        resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}` },
          body: JSON.stringify({ email, password })
        });
      } catch (e) {
        throw new Error('Cannot reach AccredReady server. Check internet connection or try disabling ad blocker / Brave Shields for this page.');
      }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.msg || data.error_description || 'Login failed');
      this.token = data.access_token;
      localStorage.setItem('ar_token', data.access_token);
      localStorage.setItem('ar_refresh', data.refresh_token);
      localStorage.setItem('ar_user', JSON.stringify(data.user));
      return data.user;
    },
    logout() {
      this.token = SUPABASE_ANON;
      localStorage.removeItem('ar_token');
      localStorage.removeItem('ar_refresh');
      localStorage.removeItem('ar_user');
    },
    getUser() {
      try { return JSON.parse(localStorage.getItem('ar_user')); } catch { return null; }
    },
    async query(table, { select = '*', eq = {}, order, limit, lte = {}, not = {}, inFilter = {} } = {}) {
      const params = new URLSearchParams({ select });
      for (const [k, v] of Object.entries(eq)) params.set(k, `eq.${v}`);
      for (const [k, v] of Object.entries(lte)) params.set(k, `lte.${v}`);
      for (const [k, v] of Object.entries(not)) params.set(k, `not.${v}`);
      for (const [k, vals] of Object.entries(inFilter)) params.set(k, `in.(${vals.join(',')})`);
      if (order) params.set('order', order);
      if (limit) params.set('limit', limit);
      let resp;
      try {
        resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, { headers: this.hdrs() });
      } catch (e) {
        throw new Error('Network error reaching AccredReady. Disable ad blocker and retry.');
      }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || `Query ${table} failed`);
      return data;
    },
    async queryOne(table, opts) {
      const rows = await this.query(table, { ...opts, limit: 1 });
      return rows[0] || null;
    },
    async count(table, eq = {}) {
      const params = new URLSearchParams({ select: 'id' });
      for (const [k, v] of Object.entries(eq)) params.set(k, `eq.${v}`);
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
        headers: this.hdrs({ Prefer: 'count=exact', Range: '0-0' })
      });
      const range = resp.headers.get('content-range') || '';
      const m = range.match(/\/(\d+)/);
      return m ? parseInt(m[1]) : 0;
    },
    async rpc(fn, params) {
      let resp;
      try {
        resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers: this.hdrs(),
          body: JSON.stringify(params)
        });
      } catch (e) {
        throw new Error('Network error calling AccredReady API.');
      }
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || `RPC ${fn} failed`);
      return data;
    },
    async insert(table, row) {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: this.hdrs({ Prefer: 'return=representation' }),
        body: JSON.stringify(row)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || `Insert ${table} failed`);
      return data;
    },
    async upsert(table, row, onConflict) {
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
        method: 'POST',
        headers: this.hdrs({ Prefer: 'resolution=merge-duplicates,return=representation' }),
        body: JSON.stringify(row)
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || `Upsert ${table} failed`);
      return data;
    }
  };
}

function initAgent(callbacks = {}) {
  onActionUpdate = callbacks.onActionUpdate || (() => {});
  onLog = callbacks.onLog || (() => {});
  if (!api) api = createApi();
  return api;
}

async function loginAccredReady(email, password) {
  initAgent();
  const user = await api.login(email, password);
  agentCtx = await loadAgentContext(user);
  onLog(`Logged in to AccredReady as ${agentCtx.hospitalName}`);
  return agentCtx;
}

async function logoutAccredReady() {
  if (api) api.logout();
  agentCtx = null;
  pendingActions = [];
  onActionUpdate(pendingActions);
}

async function restoreSession() {
  initAgent();
  const user = api.getUser();
  if (!user || !localStorage.getItem('ar_token')) return null;
  try {
    agentCtx = await loadAgentContext(user);
    return agentCtx;
  } catch {
    api.logout();
    return null;
  }
}

async function loadAgentContext(user) {
  const prof = await api.queryOne('profiles', { select: 'id,hospital_id,role,name', eq: { id: user.id } });
  if (!prof?.hospital_id) throw new Error('No hospital linked. Complete setup at accredready.in first.');

  const hosp = await api.queryOne('hospitals', { select: '*', eq: { id: prof.hospital_id } });
  const assessments = await api.query('assessments', {
    select: 'id,name,status,created_at',
    eq: { hospital_id: prof.hospital_id },
    order: 'created_at.desc'
  });
  if (!assessments?.length) throw new Error('No assessment found. Create one in AccredReady app first.');

  return {
    userId: user.id,
    userEmail: user.email,
    hospitalId: prof.hospital_id,
    hospitalName: hosp?.name || 'Hospital',
    plan: hosp?.plan,
    nabhStatus: hosp?.nabh_status,
    assessmentId: assessments[0].id,
    assessmentName: assessments[0].name,
    role: prof.role,
    userName: prof.name
  };
}

async function executeTool(name, args) {
  if (!agentCtx) throw new Error('Not logged in to AccredReady');
  switch (name) {
    case 'get_hospital_summary': return getHospitalSummary();
    case 'get_compliance_status': return getComplianceStatus();
    case 'get_active_gaps': return getActiveGaps(args.limit || 15);
    case 'get_low_scored_oes': return getLowScoredOes(args.limit || 20);
    case 'get_expiring_licenses': return getExpiringLicenses(args.days || 90);
    case 'get_kpi_status': return getKpiStatus(args.month, args.year);
    case 'get_recent_audits': return getRecentAudits(args.limit || 10);
    case 'update_oe_score': return queueWrite(name, args, `Score ${args.oe_id} = ${args.score}`);
    case 'create_capa': return queueWrite(name, args, `CAPA for ${args.oe_id}: ${args.action_planned}`);
    case 'add_committee_meeting': return queueWrite(name, args, `Meeting committee #${args.committee_id} on ${args.meeting_date}`);
    case 'add_calendar_item': return queueWrite(name, args, `Calendar: ${args.item_type} #${args.item_id} on ${args.planned_date}`);
    default: return { error: `Unknown tool: ${name}` };
  }
}

async function getHospitalSummary() {
  const scores = await api.query('scores', { select: 'oe_id,score', eq: { assessment_id: agentCtx.assessmentId } });
  const withScore = scores.filter(s => s.score != null);
  const low = withScore.filter(s => s.score <= 2);
  const avg = withScore.length ? (withScore.reduce((a, s) => a + s.score, 0) / withScore.length).toFixed(2) : 0;
  const totalOes = await api.count('objective_elements');
  return {
    hospital: agentCtx.hospitalName, assessment: agentCtx.assessmentName, plan: agentCtx.plan,
    nabh_status: agentCtx.nabhStatus, total_oes: totalOes || 639, scored_count: withScore.length,
    unscored_count: (totalOes || 639) - withScore.length, average_score: parseFloat(avg),
    critical_low_scores: low.length, low_score_oes: low.slice(0, 5).map(s => s.oe_id)
  };
}

async function getComplianceStatus() {
  try { return await api.rpc('get_final_decision', { param_id: agentCtx.assessmentId }); }
  catch (e) { return { error: e.message }; }
}

async function getActiveGaps(limit) {
  try {
    const data = await api.rpc('get_active_gaps', { param_id: agentCtx.assessmentId });
    const gaps = Array.isArray(data) ? data : (data ? [data] : []);
    return { count: gaps.length, gaps: gaps.slice(0, limit) };
  } catch (e) { return { error: e.message }; }
}

async function getLowScoredOes(limit) {
  const scores = await api.query('scores', {
    select: 'oe_id,score', eq: { assessment_id: agentCtx.assessmentId },
    lte: { score: 2 }, not: { score: 'is.null' }, order: 'score.asc', limit
  });
  if (!scores.length) return { count: 0, oes: [] };
  const oeIds = scores.map(s => s.oe_id);
  const oes = await api.query('objective_elements', {
    select: 'id,text,level,chapter_id', inFilter: { id: oeIds }
  });
  const oeMap = Object.fromEntries(oes.map(o => [o.id, o]));
  return {
    count: scores.length,
    oes: scores.map(s => ({
      oe_id: s.oe_id, score: s.score, level: oeMap[s.oe_id]?.level,
      chapter: oeMap[s.oe_id]?.chapter_id, text: (oeMap[s.oe_id]?.text || '').substring(0, 120)
    }))
  };
}

async function getExpiringLicenses(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const licenses = await api.query('statutory_licenses', {
    select: 'license_name,license_number,expiry_date,issuing_authority',
    eq: { hospital_id: agentCtx.hospitalId },
    lte: { expiry_date: cutoff.toISOString().split('T')[0] },
    order: 'expiry_date.asc'
  });
  return { count: licenses.length, licenses };
}

async function getKpiStatus(month, year) {
  const now = new Date();
  const m = month || now.getMonth() + 1;
  const y = year || now.getFullYear();
  const kpis = await api.query('kpi_data', {
    select: 'kpi_id,value,numerator,denominator,capa_required,capa_notes,trend',
    eq: { hospital_id: agentCtx.hospitalId, month: m, year: y }
  });
  return { month: m, year: y, entries: kpis.length, kpis };
}

async function getRecentAudits(limit) {
  const audits = await api.query('audit_records', {
    select: 'audit_date,auditor_name,department,compliant_count,sample_size,status,findings',
    eq: { hospital_id: agentCtx.hospitalId },
    order: 'audit_date.desc', limit
  });
  return {
    audits: audits.map(a => ({
      ...a, compliance_pct: a.sample_size ? Math.round((a.compliant_count / a.sample_size) * 100) : null
    }))
  };
}

function queueWrite(toolName, args, label) {
  const action = { id: Math.random().toString(36).slice(2), toolName, args, label, status: 'pending', createdAt: new Date().toISOString() };
  pendingActions.push(action);
  onActionUpdate([...pendingActions]);
  onLog(`Action queued for approval: ${label}`);
  return { status: 'queued_for_approval', action_id: action.id, message: `Click Approve in Actions panel to execute: ${label}` };
}

async function approveAction(actionId) {
  const action = pendingActions.find(a => a.id === actionId);
  if (!action || action.status !== 'pending') throw new Error('Action not found');
  try {
    action.result = await runWriteTool(action.toolName, action.args);
    action.status = 'done';
    onLog(`✓ Executed: ${action.label}`);
  } catch (e) {
    action.status = 'failed';
    action.error = e.message;
    onLog(`✗ Failed: ${action.label} — ${e.message}`);
    onActionUpdate([...pendingActions]);
    throw e;
  }
  onActionUpdate([...pendingActions]);
  return action.result;
}

function rejectAction(actionId) {
  const action = pendingActions.find(a => a.id === actionId);
  if (action) { action.status = 'rejected'; onLog(`Skipped: ${action.label}`); }
  onActionUpdate([...pendingActions]);
}

async function runWriteTool(name, args) {
  switch (name) {
    case 'update_oe_score': {
      const score = Math.min(5, Math.max(1, parseInt(args.score)));
      await api.upsert('scores', {
        assessment_id: agentCtx.assessmentId, oe_id: args.oe_id, score,
        updated_at: new Date().toISOString(), updated_by: agentCtx.userId
      }, 'assessment_id,oe_id');
      return { success: true, oe_id: args.oe_id, score };
    }
    case 'create_capa': {
      await api.upsert('capa', {
        assessment_id: agentCtx.assessmentId, oe_id: args.oe_id, finding: args.finding,
        root_cause: args.root_cause || '', action_planned: args.action_planned,
        action_type: args.action_type || 'Process', responsible_person: args.responsible_person || '',
        target_date: args.target_date || null, status: 'open'
      }, 'assessment_id,oe_id');
      return { success: true, oe_id: args.oe_id };
    }
    case 'add_committee_meeting': {
      await api.insert('committee_meetings', {
        hospital_id: agentCtx.hospitalId, committee_id: args.committee_id,
        meeting_date: args.meeting_date, chairperson: args.chairperson || '',
        venue: args.venue || '', quorum_met: false, members_present: 0, members_total: 0, agenda_items: []
      });
      return { success: true };
    }
    case 'add_calendar_item': {
      const d = new Date(args.planned_date);
      await api.insert('calendar_plan', {
        hospital_id: agentCtx.hospitalId, item_type: args.item_type, item_id: args.item_id,
        planned_date: args.planned_date, year: d.getFullYear(), month: d.getMonth() + 1
      });
      return { success: true };
    }
    default: throw new Error(`Unknown write tool: ${name}`);
  }
}

async function runAgent(groqApiKey, model, messages, systemPrompt) {
  const maxSteps = 6;
  let step = 0;
  const msgs = [{ role: 'system', content: systemPrompt }, ...messages];

  while (step < maxSteps) {
    step++;
    let resp;
    try {
      resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` },
        body: JSON.stringify({
          model: model || 'llama-3.3-70b-versatile', messages: msgs, tools: AGENT_TOOLS,
          tool_choice: 'auto', max_tokens: 2048, temperature: 0.4
        })
      });
    } catch (e) {
      throw new Error('Cannot reach Groq API. Check your API key and internet connection.');
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `Groq error ${resp.status}`);

    const choice = data.choices[0];
    const msg = choice.message;
    msgs.push(msg);

    if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
      return { reply: msg.content || 'Done.', steps: step };
    }

    for (const tc of msg.tool_calls) {
      const fn = tc.function;
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch (_) {}
      onLog(`Tool: ${fn.name}`);
      let result;
      try { result = await executeTool(fn.name, args); } catch (e) { result = { error: e.message }; }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { reply: 'Done. Check Actions panel for pending approvals.', steps: step };
}

const AGENT_SYSTEM = `You are the AccredReady Real Agent with LIVE access to the user's NABH database.

Use tools to read real data before answering. Never guess scores or gaps.
Write actions (score OE, CAPA, meetings) queue for user approval — tell them to click Approve.
Be specific with OE codes and numbers from tool results.`;

window.AccredAgent = {
  initAgent, loginAccredReady, logoutAccredReady, restoreSession,
  runAgent, approveAction, rejectAction, executeTool,
  getContext: () => agentCtx,
  getPendingActions: () => pendingActions,
  AGENT_SYSTEM, AGENT_TOOLS, WRITE_TOOLS
};

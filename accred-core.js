/**
 * AccredReady Real Agent — Supabase tools + Groq function calling
 */
const SUPABASE_URL = 'https://tbptllgcjtiiqspxqcde.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRicHRsbGdjanRpaXFzcHhxY2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2NjkzNjAsImV4cCI6MjA5MjI0NTM2MH0.4CPgNp6ytVNRmTU0FJbu2io94QJmsAow5im-vGtoRAU';

let supabase = null;
let agentCtx = null;
let pendingActions = [];
let onActionUpdate = null;
let onLog = null;

const WRITE_TOOLS = new Set([
  'update_oe_score', 'create_capa', 'add_committee_meeting', 'add_calendar_item', 'add_license'
]);

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_hospital_summary',
      description: 'Get hospital name, plan, NABH status, assessment name, and score statistics (total scored, average, low scores count).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_compliance_status',
      description: 'Get NABH compliance verdict: pass/fail, readiness %, pillar scores using get_final_decision RPC.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_active_gaps',
      description: 'List active compliance gaps that need fixing (failed OEs, missing docs, low scores).',
      parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max gaps to return (default 15)' } }, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_low_scored_oes',
      description: 'List OEs scored 2 or below (critical failures).',
      parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_expiring_licenses',
      description: 'List statutory licenses expiring within N days.',
      parameters: { type: 'object', properties: { days: { type: 'number', description: 'Days ahead to check (default 90)' } }, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_kpi_status',
      description: 'Get KPI entries for a given month/year with values and CAPA flags.',
      parameters: {
        type: 'object',
        properties: {
          month: { type: 'number' },
          year: { type: 'number' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_audits',
      description: 'Get recent clinical/nursing audit records with compliance rates.',
      parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_oe_score',
      description: 'Score an Objective Element 1-5 in AccredReady. REQUIRES user approval before executing.',
      parameters: {
        type: 'object',
        properties: {
          oe_id: { type: 'string', description: 'OE code e.g. AAC.1.a' },
          score: { type: 'number', description: 'Score 1-5' }
        },
        required: ['oe_id', 'score']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_capa',
      description: 'Create CAPA for a failed OE. REQUIRES user approval.',
      parameters: {
        type: 'object',
        properties: {
          oe_id: { type: 'string' },
          finding: { type: 'string' },
          action_planned: { type: 'string' },
          responsible_person: { type: 'string' },
          target_date: { type: 'string', description: 'YYYY-MM-DD' }
        },
        required: ['oe_id', 'finding', 'action_planned']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_committee_meeting',
      description: 'Schedule a committee meeting record. REQUIRES user approval.',
      parameters: {
        type: 'object',
        properties: {
          committee_id: { type: 'number' },
          meeting_date: { type: 'string', description: 'YYYY-MM-DD' },
          chairperson: { type: 'string' },
          venue: { type: 'string' }
        },
        required: ['committee_id', 'meeting_date']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'add_calendar_item',
      description: 'Add committee or drill to calendar plan. REQUIRES user approval.',
      parameters: {
        type: 'object',
        properties: {
          item_type: { type: 'string', enum: ['committee', 'drill'] },
          item_id: { type: 'number' },
          planned_date: { type: 'string', description: 'YYYY-MM-DD' }
        },
        required: ['item_type', 'item_id', 'planned_date']
      }
    }
  }
];

function initAgent(callbacks = {}) {
  onActionUpdate = callbacks.onActionUpdate || (() => {});
  onLog = callbacks.onLog || (() => {});
  if (!supabase) {
    const { createClient } = window.supabase;
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }
  return supabase;
}

async function loginAccredReady(email, password) {
  initAgent();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  agentCtx = await loadAgentContext(data.user);
  onLog(`Logged in to AccredReady as ${agentCtx.hospitalName}`);
  return agentCtx;
}

async function logoutAccredReady() {
  if (supabase) await supabase.auth.signOut();
  agentCtx = null;
  pendingActions = [];
  onActionUpdate(pendingActions);
}

async function restoreSession() {
  initAgent();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return null;
  agentCtx = await loadAgentContext(session.user);
  return agentCtx;
}

async function loadAgentContext(user) {
  const { data: prof, error: pErr } = await supabase
    .from('profiles')
    .select('id, hospital_id, role, name')
    .eq('id', user.id)
    .single();
  if (pErr || !prof?.hospital_id) throw new Error('No hospital linked to this AccredReady account. Complete setup at accredready.in first.');

  const { data: hosp } = await supabase.from('hospitals').select('*').eq('id', prof.hospital_id).single();
  const { data: assessments } = await supabase
    .from('assessments')
    .select('id, name, status, created_at')
    .eq('hospital_id', prof.hospital_id)
    .order('created_at', { ascending: false });

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
  const { data: scores } = await supabase
    .from('scores')
    .select('oe_id, score')
    .eq('assessment_id', agentCtx.assessmentId);

  const scored = scores || [];
  const withScore = scored.filter(s => s.score != null);
  const low = withScore.filter(s => s.score <= 2);
  const avg = withScore.length
    ? (withScore.reduce((a, s) => a + s.score, 0) / withScore.length).toFixed(2)
    : 0;

  const { count: totalOes } = await supabase
    .from('objective_elements')
    .select('id', { count: 'exact', head: true });

  return {
    hospital: agentCtx.hospitalName,
    assessment: agentCtx.assessmentName,
    plan: agentCtx.plan,
    nabh_status: agentCtx.nabhStatus,
    total_oes: totalOes || 639,
    scored_count: withScore.length,
    unscored_count: (totalOes || 639) - withScore.length,
    average_score: parseFloat(avg),
    critical_low_scores: low.length,
    low_score_oes: low.slice(0, 5).map(s => s.oe_id)
  };
}

async function getComplianceStatus() {
  const { data, error } = await supabase.rpc('get_final_decision', { param_id: agentCtx.assessmentId });
  if (error) return { error: error.message };
  return data;
}

async function getActiveGaps(limit) {
  const { data, error } = await supabase.rpc('get_active_gaps', { param_id: agentCtx.assessmentId });
  if (error) return { error: error.message };
  const gaps = Array.isArray(data) ? data : (data ? [data] : []);
  return { count: gaps.length, gaps: gaps.slice(0, limit) };
}

async function getLowScoredOes(limit) {
  const { data: scores } = await supabase
    .from('scores')
    .select('oe_id, score')
    .eq('assessment_id', agentCtx.assessmentId)
    .lte('score', 2)
    .not('score', 'is', null)
    .order('score')
    .limit(limit);

  if (!scores?.length) return { count: 0, oes: [] };

  const oeIds = scores.map(s => s.oe_id);
  const { data: oes } = await supabase
    .from('objective_elements')
    .select('id, text, level, chapter_id')
    .in('id', oeIds);

  const oeMap = Object.fromEntries((oes || []).map(o => [o.id, o]));
  return {
    count: scores.length,
    oes: scores.map(s => ({
      oe_id: s.oe_id,
      score: s.score,
      level: oeMap[s.oe_id]?.level,
      chapter: oeMap[s.oe_id]?.chapter_id,
      text: (oeMap[s.oe_id]?.text || '').substring(0, 120)
    }))
  };
}

async function getExpiringLicenses(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const { data } = await supabase
    .from('statutory_licenses')
    .select('license_name, license_number, expiry_date, issuing_authority')
    .eq('hospital_id', agentCtx.hospitalId)
    .lte('expiry_date', cutoff.toISOString().split('T')[0])
    .order('expiry_date');
  return { count: data?.length || 0, licenses: data || [] };
}

async function getKpiStatus(month, year) {
  const now = new Date();
  const m = month || now.getMonth() + 1;
  const y = year || now.getFullYear();
  const { data } = await supabase
    .from('kpi_data')
    .select('kpi_id, value, numerator, denominator, capa_required, capa_notes, trend')
    .eq('hospital_id', agentCtx.hospitalId)
    .eq('month', m)
    .eq('year', y);
  return { month: m, year: y, entries: data?.length || 0, kpis: data || [] };
}

async function getRecentAudits(limit) {
  const { data } = await supabase
    .from('audit_records')
    .select('audit_date, auditor_name, department, compliant_count, sample_size, status, findings')
    .eq('hospital_id', agentCtx.hospitalId)
    .order('audit_date', { ascending: false })
    .limit(limit);
  return {
    audits: (data || []).map(a => ({
      ...a,
      compliance_pct: a.sample_size ? Math.round((a.compliant_count / a.sample_size) * 100) : null
    }))
  };
}

function queueWrite(toolName, args, label) {
  const action = {
    id: Math.random().toString(36).slice(2),
    toolName,
    args,
    label,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  pendingActions.push(action);
  onActionUpdate([...pendingActions]);
  onLog(`Action queued for approval: ${label}`);
  return {
    status: 'queued_for_approval',
    action_id: action.id,
    message: `Action "${label}" queued. User must click Approve in the Actions panel to execute in AccredReady.`
  };
}

async function approveAction(actionId) {
  const action = pendingActions.find(a => a.id === actionId);
  if (!action || action.status !== 'pending') throw new Error('Action not found');

  let result;
  try {
    result = await runWriteTool(action.toolName, action.args);
    action.status = 'done';
    action.result = result;
    onLog(`✓ Executed: ${action.label}`);
  } catch (e) {
    action.status = 'failed';
    action.error = e.message;
    onLog(`✗ Failed: ${action.label} — ${e.message}`);
    throw e;
  }
  onActionUpdate([...pendingActions]);
  return result;
}

function rejectAction(actionId) {
  const action = pendingActions.find(a => a.id === actionId);
  if (action) {
    action.status = 'rejected';
    onLog(`Skipped action: ${action.label}`);
  }
  onActionUpdate([...pendingActions]);
}

async function runWriteTool(name, args) {
  switch (name) {
    case 'update_oe_score': {
      const score = Math.min(5, Math.max(1, parseInt(args.score)));
      const { error } = await supabase.from('scores').upsert({
        assessment_id: agentCtx.assessmentId,
        oe_id: args.oe_id,
        score,
        updated_at: new Date().toISOString(),
        updated_by: agentCtx.userId
      }, { onConflict: 'assessment_id,oe_id' });
      if (error) throw new Error(error.message);
      return { success: true, oe_id: args.oe_id, score };
    }
    case 'create_capa': {
      const { error } = await supabase.from('capa').upsert({
        assessment_id: agentCtx.assessmentId,
        oe_id: args.oe_id,
        finding: args.finding,
        root_cause: args.root_cause || '',
        action_planned: args.action_planned,
        action_type: args.action_type || 'Process',
        responsible_person: args.responsible_person || '',
        target_date: args.target_date || null,
        status: 'open'
      }, { onConflict: 'assessment_id,oe_id' });
      if (error) throw new Error(error.message);
      return { success: true, oe_id: args.oe_id };
    }
    case 'add_committee_meeting': {
      const { error } = await supabase.from('committee_meetings').insert({
        hospital_id: agentCtx.hospitalId,
        committee_id: args.committee_id,
        meeting_date: args.meeting_date,
        chairperson: args.chairperson || '',
        venue: args.venue || '',
        quorum_met: false,
        members_present: 0,
        members_total: 0,
        agenda_items: []
      });
      if (error) throw new Error(error.message);
      return { success: true, committee_id: args.committee_id, meeting_date: args.meeting_date };
    }
    case 'add_calendar_item': {
      const d = new Date(args.planned_date);
      const { error } = await supabase.from('calendar_plan').insert({
        hospital_id: agentCtx.hospitalId,
        item_type: args.item_type,
        item_id: args.item_id,
        planned_date: args.planned_date,
        year: d.getFullYear(),
        month: d.getMonth() + 1
      });
      if (error) throw new Error(error.message);
      return { success: true };
    }
    default:
      throw new Error(`Unknown write tool: ${name}`);
  }
}

async function runAgent(groqApiKey, model, messages, systemPrompt) {
  const maxSteps = 6;
  let step = 0;
  const msgs = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  while (step < maxSteps) {
    step++;
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: model || 'llama-3.3-70b-versatile',
        messages: msgs,
        tools: AGENT_TOOLS,
        tool_choice: 'auto',
        max_tokens: 2048,
        temperature: 0.4
      })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || `Groq error ${resp.status}`);

    const choice = data.choices[0];
    const msg = choice.message;
    msgs.push(msg);

    if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
      return { reply: msg.content || 'Done.', steps: step, messages: msgs };
    }

    for (const tc of msg.tool_calls) {
      const fn = tc.function;
      let args = {};
      try { args = JSON.parse(fn.arguments || '{}'); } catch (_) {}

      onLog(`Tool: ${fn.name}(${JSON.stringify(args).substring(0, 80)})`);

      let result;
      try {
        result = await executeTool(fn.name, args);
      } catch (e) {
        result = { error: e.message };
      }

      msgs.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result)
      });
    }
  }

  return { reply: 'Reached max agent steps. Check Actions panel for pending items.', steps: step, messages: msgs };
}

const AGENT_SYSTEM = `You are the AccredReady Real Agent — an autonomous AI operator for NABH hospital accreditation.

You have REAL tools connected to the user's AccredReady database. You can:
- READ hospital data (scores, gaps, licenses, KPIs, audits) — use tools immediately
- WRITE data (score OEs, create CAPA, schedule meetings) — these queue for user approval

RULES:
1. Always use tools to get real data before advising. Never guess scores or gaps.
2. For write actions, call the tool then tell user to Approve in Actions panel.
3. Be specific with OE codes, dates, and numbers from tool results.
4. Prioritize: critical gaps (score ≤2) → expiring licenses → unscored OEs → KPIs.
5. When user asks to "fix" or "update" something, use the appropriate write tool.

Hospital context is loaded from their AccredReady login.`;

window.AccredAgent = {
  initAgent, loginAccredReady, logoutAccredReady, restoreSession,
  runAgent, approveAction, rejectAction, executeTool,
  getContext: () => agentCtx,
  getPendingActions: () => pendingActions,
  AGENT_SYSTEM, AGENT_TOOLS, WRITE_TOOLS
};

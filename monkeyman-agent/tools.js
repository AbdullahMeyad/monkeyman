// tools.js
// All MonkeyMan operations exposed as Anthropic-format tools.
// Tool names mirror the friendly names from the system prompt with spaces -> underscores
// (e.g. "Get pto by email" -> "Get_pto_by_email") so Claude maps them with zero ambiguity.

import 'dotenv/config';
import { sendOtp, verifyOtp } from './otp.js';

const API = process.env.MONKEYMAN_API_BASE || 'https://server.monkeymans.com/api';

// ──────────────────────────────────────────────────────────────────────────────
// HTTP helper — single place for fetch, query encoding, and error shaping
// ──────────────────────────────────────────────────────────────────────────────
async function http(method, path, { query, body } = {}) {
  const url = new URL(`${API}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    text = await res.text();
  } catch (err) {
    return { error: true, message: `Network error: ${err.message}`, url: url.toString() };
  }
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) return { error: true, status: res.status, data };
  return data;
}

const enc = encodeURIComponent;

// ──────────────────────────────────────────────────────────────────────────────
// Tool definitions (Anthropic format) + handler implementations
// Each entry pairs a JSON-schema tool spec with the JS function that runs it.
// ──────────────────────────────────────────────────────────────────────────────
const TOOLS = [

  // ─── Employee / Role ─────────────────────────────────────────────────────
  {
    spec: {
      name: 'Retrieve_All_Employee_Details',
      description: 'List or search all employees in the MonkeyMan system. Use to resolve a name to an email when the user gives a person\'s name instead of an email.',
      input_schema: { type: 'object', properties: {} },
    },
    handler: () => http('GET', '/employee/all'),
  },
  {
    spec: {
      name: 'Retrieve_Specific_Employee_Details',
      description: 'Get an employee profile (including the MongoDB _id) by their email address. Required to resolve _id values before calling Daily_task_create.',
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Employee email address' } },
        required: ['email'],
      },
    },
    handler: ({ email }) => http('GET', `/employee/email/${enc(email)}`),
  },
  {
    spec: {
      name: 'Get_user_role_and_permissions',
      description: 'Get an employee\'s role, status, and feature-access permissions list by email. Call this FIRST before any write action to enforce role gating (PTO approve, VTR verify, task create, incident report, PTO request).',
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Employee email address' } },
        required: ['email'],
      },
    },
    handler: ({ email }) => http('GET', `/employee/email/${enc(email)}/role`),
  },

  // ─── Tasks / Projects / Equipment ────────────────────────────────────────
  {
    spec: {
      name: 'projects_tool',
      description: 'Retrieve projects associated with an employee by email. Used to resolve a project _id when creating a task.',
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Employee email address' } },
        required: ['email'],
      },
    },
    handler: ({ email }) => http('GET', `/projects/email/${enc(email)}`),
  },
  {
    spec: {
      name: 'equipment_products_tool',
      description: 'Retrieve the full equipment / product inventory.',
      input_schema: { type: 'object', properties: {} },
    },
    handler: () => http('GET', '/product', { query: { page: 1, limit: 9000000 } }),
  },
  {
    spec: {
      name: 'Get_task_by_email',
      description: 'List tasks assigned to a specific employee by email.',
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Employee email address' } },
        required: ['email'],
      },
    },
    handler: ({ email }) => http('GET', `/daily-task/email/${enc(email)}`),
  },
  {
    spec: {
      name: 'Get_today_task',
      description: "Retrieve all of today's tasks (no filtering by user).",
      input_schema: { type: 'object', properties: {} },
    },
    handler: () => http('GET', '/daily-task'),
  },
  {
    spec: {
      name: 'Get_task_by_create_date',
      description: 'Retrieve tasks by their creation date.',
      input_schema: {
        type: 'object',
        properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format' } },
        required: ['date'],
      },
    },
    handler: ({ date }) => http('GET', '/daily-task', { query: { createdAt: date } }),
  },
  {
    spec: {
      name: 'Daily_task_create',
      description: 'Create a daily task. STRICT: assignedBy and every entry in assignedTo MUST be 24-character MongoDB _id strings (NOT emails or names) resolved via Retrieve_Specific_Employee_Details. The OTP gate must pass on the manager email before calling this tool.',
      input_schema: {
        type: 'object',
        properties: {
          title:       { type: 'string', description: 'Task title' },
          details:     { type: 'string', description: 'Task description and details' },
          priority:    { type: 'string', enum: ['high', 'medium', 'low'], description: 'Task priority' },
          dueDate:     { type: 'string', description: 'Due date in ISO 8601, e.g. 2026-02-25T00:00:00.000Z' },
          assignedBy:  { type: 'string', description: "Manager's MongoDB _id (24-char hex). Resolve via Retrieve_Specific_Employee_Details." },
          assignedTo:  { type: 'array', items: { type: 'string' }, description: 'Array of assignee MongoDB _id strings (24-char hex each).' },
          project:     { type: ['string', 'null'], description: 'Project _id or null', default: null },
          attachments: { type: 'array', items: {}, default: [] },
        },
        required: ['title', 'details', 'priority', 'dueDate', 'assignedBy', 'assignedTo'],
      },
    },
    handler: (input) => http('POST', '/daily-task', {
      body: { project: null, attachments: [], ...input },
    }),
  },

  // ─── PTO ─────────────────────────────────────────────────────────────────
  {
    spec: {
      name: 'Get_pto_by_email',
      description: 'PRIMARY tool for PTO lookups. Returns all PTO records for a given employee email.',
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Employee email address' } },
        required: ['email'],
      },
    },
    handler: ({ email }) => http('GET', `/pto/email/${enc(email)}`),
  },
  {
    spec: {
      name: 'Get_PTO_by_id',
      description: 'Retrieve a single PTO record by its MongoDB _id (24-char hex).',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'PTO _id (24-character hex string)' } },
        required: ['id'],
      },
    },
    handler: ({ id }) => http('GET', `/pto/${enc(id)}`),
  },
  {
    spec: {
      name: 'Get_all_PTO',
      description: 'LAST RESORT — fetches ALL PTO records overlapping a date range across the company. Always prefer Get_pto_by_email first. If used, you MUST filter the results by the requested employee email locally before showing anything.',
      input_schema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Range start in YYYY-MM-DD' },
          endDate:   { type: 'string', description: 'Range end in YYYY-MM-DD' },
        },
        required: ['startDate', 'endDate'],
      },
    },
    handler: ({ startDate, endDate }) => http('GET', '/pto', { query: { startDate, endDate } }),
  },
  {
    spec: {
      name: 'Request_a_PTO',
      description: 'Submit a PTO request. Requires the role gate (Active employee with my_time_off_requests.create) and OTP gate on the submitter email to pass first. Reason MUST be rewritten formally before calling.',
      input_schema: {
        type: 'object',
        properties: {
          email:     { type: 'string', description: 'Submitter email' },
          startDate: { type: 'string', description: 'YYYY-MM-DD' },
          endDate:   { type: 'string', description: 'YYYY-MM-DD' },
          leaveType: {
            type: 'string',
            enum: ['Vacation', 'Sick', 'Time Off Without Pay', 'Training/Continuing Education', 'Jury Duty', 'Bereavement', 'Other'],
            description: 'Normalized leave type',
          },
          reason: { type: 'string', description: 'Formalized 1–2 sentence reason (no slang, neutral tone, typos fixed)' },
        },
        required: ['email', 'startDate', 'endDate', 'leaveType', 'reason'],
      },
    },
    handler: (body) => http('POST', '/pto', { body }),
  },
  {
    spec: {
      name: 'Approve_or_Deny_a_PTO',
      description: 'Approve or reject a PTO request. MANAGER-ONLY. Both gates required. action MUST be exactly "approved" or "rejected" (lowercase).',
      input_schema: {
        type: 'object',
        properties: {
          id:            { type: 'string', description: 'PTO _id (24-char hex)' },
          action:        { type: 'string', enum: ['approved', 'rejected'], description: 'Lowercase action — exactly "approved" or "rejected"' },
          comment:       { type: 'string', description: 'Formalized approval/rejection comment' },
          approverEmail: { type: 'string', description: 'Email of the manager performing the action' },
        },
        required: ['id', 'action', 'comment', 'approverEmail'],
      },
    },
    handler: ({ id, action, comment, approverEmail }) =>
      http('POST', `/pto/${enc(id)}/status`, { body: { action, comment, approverEmail } }),
  },

  // ─── VTR / Timecard ──────────────────────────────────────────────────────
  {
    spec: {
      name: 'Get_VTR_by_email',
      description: 'Retrieve VTR (timecard) records for an employee. Provide either weekEnding OR (startDate AND endDate). With no date params, defaults to today.',
      input_schema: {
        type: 'object',
        properties: {
          email:      { type: 'string', description: 'Employee email' },
          weekEnding: { type: 'string', description: 'Optional. Single YYYY-MM-DD date for a 7-day window.' },
          startDate:  { type: 'string', description: 'Optional. Range start YYYY-MM-DD.' },
          endDate:    { type: 'string', description: 'Optional. Range end YYYY-MM-DD.' },
        },
        required: ['email'],
      },
    },
    handler: ({ email, weekEnding, startDate, endDate }) =>
      http('GET', `/timecard/email/${enc(email)}`, { query: { weekEnding, startDate, endDate } }),
  },
  {
    spec: {
      name: 'Verify_VTR',
      description: 'Mark a VTR as verified. MANAGER-ONLY. Both gates required on verifiedByEmail.',
      input_schema: {
        type: 'object',
        properties: {
          id:               { type: 'string', description: 'VTR _id (24-char hex), resolved via Get_VTR_by_email' },
          verifiedByEmail:  { type: 'string', description: 'Email of the manager performing the verification' },
        },
        required: ['id', 'verifiedByEmail'],
      },
    },
    handler: ({ id, verifiedByEmail }) =>
      http('POST', `/timecard/${enc(id)}/verify`, { body: { verifiedByEmail } }),
  },

  // ─── Incidents ───────────────────────────────────────────────────────────
  {
    spec: {
      name: 'Report_incident',
      description: 'File a new incident report. completedByEmail and incidentDescription are required. Both gates required on completedByEmail.',
      input_schema: {
        type: 'object',
        properties: {
          completedByEmail:      { type: 'string', description: 'Email of the person filing the report' },
          incidentDescription:   { type: 'string', description: 'Required description of the incident' },
          completedDate:         { type: 'string', description: 'Optional ISO datetime when the report was completed' },
          signature:             { type: 'string', description: 'Optional signature/name string' },
          incidentDateTime:      { type: 'string', description: 'Optional ISO datetime of the incident itself' },
          personsInvolvedEmails: { type: 'array', items: { type: 'string' }, description: 'Optional emails of persons involved (resolve names first if needed)' },
          witnessesEmails:       { type: 'array', items: { type: 'string' }, description: 'Optional witness emails' },
          injuries:              { type: 'string', description: 'Optional injuries description' },
          reportedToEmail:       { type: 'string', description: 'Optional email of person the incident was reported to' },
          howReported:           { type: 'string', enum: ['form', 'in person', 'email', 'phone', 'other'], description: 'Optional reporting channel' },
          followUpActions:       { type: 'string', description: 'Optional follow-up actions taken or planned' },
          address:               { type: 'string', description: 'Optional address where the incident occurred' },
          workOrder:             { type: 'string', description: 'Optional work order number' },
        },
        required: ['completedByEmail', 'incidentDescription'],
      },
    },
    handler: (body) => http('POST', '/incident-report', { body }),
  },
  {
    spec: {
      name: 'Get_incidents_by_email',
      description: 'Retrieve past incident reports for an employee (filed by, involved in, or witnessing). Supports pagination.',
      input_schema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Employee email' },
          page:  { type: 'string', description: 'Optional page number (default 1)' },
          limit: { type: 'string', description: 'Optional page size (default 20, max 100)' },
        },
        required: ['email'],
      },
    },
    handler: ({ email, page, limit }) =>
      http('GET', `/incident-report/email/${enc(email)}`, { query: { page, limit } }),
  },

  // ─── On-Call ─────────────────────────────────────────────────────────────
  {
    spec: {
      name: 'Get_my_on_call_schedule',
      description: "Retrieve the on-call schedule for a specific employee's team(s) by email.",
      input_schema: {
        type: 'object',
        properties: { email: { type: 'string', description: 'Employee email' } },
        required: ['email'],
      },
    },
    handler: ({ email }) => http('GET', `/oncall/email/${enc(email)}`),
  },
  {
    spec: {
      name: 'Get_all_on_call_rotations',
      description: 'Retrieve all on-call rotations. Optional year + month filter (must pair).',
      input_schema: {
        type: 'object',
        properties: {
          year:  { type: 'string', description: 'Optional year e.g. 2026' },
          month: { type: 'string', description: 'Optional month 1–12' },
        },
      },
    },
    handler: ({ year, month }) => http('GET', '/oncall', { query: { year, month } }),
  },
  {
    spec: {
      name: 'Get_on_call_by_date_range',
      description: 'Retrieve on-call rotations overlapping a date range. Both dates required in YYYY-MM-DD.',
      input_schema: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'YYYY-MM-DD' },
          endDate:   { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['startDate', 'endDate'],
      },
    },
    handler: ({ startDate, endDate }) => http('GET', '/oncall/date-range', { query: { startDate, endDate } }),
  },

  // ─── Forms / Checklists ──────────────────────────────────────────────────
  {
    spec: {
      name: 'List_forms',
      description: 'Retrieve all active checklist templates / forms, sorted by display order.',
      input_schema: { type: 'object', properties: {} },
    },
    handler: () => http('GET', '/forms'),
  },
  {
    spec: {
      name: 'Get_form_by_id',
      description: 'Retrieve a specific form template by its _id (24-char hex).',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Form _id' } },
        required: ['id'],
      },
    },
    handler: ({ id }) => http('GET', `/forms/${enc(id)}`),
  },

  // ─── Permits ─────────────────────────────────────────────────────────────
  {
    spec: {
      name: 'Permit_rules_lookup',
      description: 'Look up permit rules. All filters optional and case-insensitive.',
      input_schema: {
        type: 'object',
        properties: {
          municipality: { type: 'string', description: 'Optional jurisdiction/city filter' },
          type:         { type: 'string', description: 'Optional permit type filter (e.g. Tree Removal)' },
          page:         { type: 'string', description: 'Optional page (default 1)' },
          limit:        { type: 'string', description: 'Optional page size (default 20, max 100)' },
        },
      },
    },
    handler: ({ municipality, type, page, limit }) =>
      http('GET', '/permit', { query: { municipality, type, page, limit } }),
  },

  // ─── OTP (now in-process — no more sub-flow webhooks) ────────────────────
  {
    spec: {
      name: 'Send_OTP',
      description: 'STEP 1 of OTP verification. Generate and email a 6-digit code to the actor. Call this only AFTER the role gate has confirmed the actor is authorized for the pending write action. After calling, ask the user to paste the code, then call Verify_OTP.',
      input_schema: {
        type: 'object',
        properties: {
          email:     { type: 'string', description: "Actor's email — the person performing the pending write action" },
          firstName: { type: 'string', description: 'Optional, from prior employee lookup' },
          lastName:  { type: 'string', description: 'Optional, from prior employee lookup' },
          phone:     { type: 'string', description: 'Optional, from prior employee lookup' },
        },
        required: ['email'],
      },
    },
    handler: (input) => sendOtp(input),
  },
  {
    spec: {
      name: 'Verify_OTP',
      description: 'STEP 2 of OTP verification. Validate the 6-digit code the user pasted. Only proceed to the pending write tool if the response has verified: true.',
      input_schema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Same email used in Send_OTP' },
          otp:   { type: 'string', description: '6-digit code the user pasted' },
        },
        required: ['email', 'otp'],
      },
    },
    handler: (input) => verifyOtp(input),
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────────────
export const toolDefinitions = TOOLS.map((t) => t.spec);
const handlers = Object.fromEntries(TOOLS.map((t) => [t.spec.name, t.handler]));

export async function executeTool(name, input) {
  const handler = handlers[name];
  if (!handler) return { error: true, message: `Unknown tool: ${name}` };
  try {
    return await handler(input || {});
  } catch (err) {
    return { error: true, message: err.message };
  }
}

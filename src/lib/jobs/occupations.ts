/**
 * Occupation taxonomy for role-based matching.
 *
 * This is search vocabulary, not knowledge: it says that a "solar installer" is occupationally close to
 * an "electrician", so the matcher looks at electrician listings too. It never states that a job exists,
 * that anyone qualifies, or anything about Golden Sierra — those come only from indexed documents.
 *
 * `titles` identify the occupation from a job title or a stated role; `skills` identify it from a
 * description of the work ("helped seniors with bathing and meals" → caregiver). `related` lists
 * occupations a person in this role could reasonably move into, with the kind of move.
 */

export type Sector =
  | 'healthcare' | 'administrative' | 'technology' | 'skilled_trades' | 'green_energy' | 'manufacturing_logistics'
  | 'sales_customer_service' | 'hospitality' | 'education_social_services' | 'public_works';
export type Collar = 'green' | 'white' | 'blue' | 'service';
export type RelationKind = 'related' | 'supervisory' | 'step_down';

export type Occupation = {
  key: string;
  title: string;
  sector: Sector;
  collar: Collar;
  supervisory?: boolean;
  titles: string[];
  skills: string[];
  related: { key: string; kind: RelationKind }[];
};

export const SECTOR_LABELS: Record<Sector, string> = {
  healthcare: 'Healthcare',
  administrative: 'Administrative & office',
  technology: 'Technology & IT',
  skilled_trades: 'Skilled trades',
  green_energy: 'Green energy',
  manufacturing_logistics: 'Manufacturing & logistics',
  sales_customer_service: 'Sales & customer service',
  hospitality: 'Hospitality',
  education_social_services: 'Education & social services',
  public_works: 'Public works & infrastructure',
};

const r = (key: string, kind: RelationKind = 'related') => ({ key, kind });

export const OCCUPATIONS: Occupation[] = [
  // ── Healthcare ──
  { key: 'caregiver', title: 'Caregiver / home care aide', sector: 'healthcare', collar: 'service',
    titles: ['caregiver', 'home care aide', 'home health aide', 'in-home care', 'senior care', 'companion care', 'personal care aide'],
    skills: ['bathing', 'dressing', 'grooming', 'personal care', 'companionship', 'meal preparation', 'elderly', 'seniors', 'aging', 'care for others'],
    related: [r('cna'), r('medical_assistant'), r('family_support')] },
  { key: 'cna', title: 'Certified nursing assistant', sector: 'healthcare', collar: 'service',
    titles: ['certified nursing assistant', 'nursing assistant', 'cna'],
    skills: ['patient care', 'vital signs', 'bedside', 'nursing'],
    related: [r('caregiver', 'step_down'), r('medical_assistant'), r('lvn')] },
  { key: 'medical_assistant', title: 'Medical assistant', sector: 'healthcare', collar: 'service',
    titles: ['medical assistant', 'clinical assistant', 'phlebotomist', 'phlebotomy'],
    skills: ['patient intake', 'vital signs', 'medical records', 'blood draw', 'clinic'],
    related: [r('cna'), r('medical_admin')] },
  { key: 'lvn', title: 'Licensed vocational / registered nurse', sector: 'healthcare', collar: 'white',
    titles: ['licensed vocational nurse', 'registered nurse', 'lvn', 'rn', 'nurse'],
    skills: ['medication administration', 'nursing care', 'patient assessment'],
    related: [r('cna', 'step_down')] },
  { key: 'medical_admin', title: 'Medical office / front desk', sector: 'healthcare', collar: 'white',
    titles: ['medical receptionist', 'medical office', 'patient services representative', 'medical billing'],
    skills: ['scheduling appointments', 'insurance verification', 'medical billing'],
    related: [r('admin_assistant'), r('medical_assistant')] },

  // ── Administrative ──
  { key: 'admin_assistant', title: 'Administrative assistant', sector: 'administrative', collar: 'white',
    titles: ['administrative assistant', 'office assistant', 'administrative support', 'receptionist', 'secretary'],
    skills: ['ms office', 'word processing', 'spreadsheets', 'filing', 'scheduling', 'receptionist', 'answering phones', 'data entry', 'typing'],
    related: [r('clerk'), r('executive_assistant', 'supervisory'), r('customer_service')] },
  { key: 'clerk', title: 'Clerk / records & legal clerk', sector: 'administrative', collar: 'white',
    titles: ['clerk', 'legal clerk', 'records clerk', 'office clerk', 'clerical'],
    skills: ['filing', 'records', 'clerical', 'data entry', 'typing', 'proofreading', 'customer service'],
    related: [r('admin_assistant'), r('admin_officer', 'supervisory')] },
  { key: 'executive_assistant', title: 'Executive assistant', sector: 'administrative', collar: 'white',
    titles: ['executive assistant'],
    skills: ['calendar management', 'board meetings', 'confidential', 'scheduling', 'ms office', 'minutes'],
    related: [r('admin_assistant', 'step_down'), r('admin_officer')] },
  { key: 'admin_officer', title: 'Administrative services officer / analyst', sector: 'administrative', collar: 'white', supervisory: true,
    titles: ['administrative services officer', 'administrative analyst', 'program analyst', 'office manager'],
    skills: ['budget', 'policy analysis', 'contracts', 'procurement', 'supervision', 'administrative services'],
    related: [r('executive_assistant'), r('admin_assistant', 'step_down'), r('accounting_assistant')] },
  { key: 'accounting_assistant', title: 'Accounting assistant / bookkeeper', sector: 'administrative', collar: 'white',
    titles: ['accounting assistant', 'bookkeeper', 'accounts payable', 'accounts receivable', 'accounting clerk', 'payroll clerk'],
    skills: ['quickbooks', 'ar/ap', 'bookkeeping', 'invoices', 'reconciliation', 'payroll', 'accounts payable', 'accounts receivable'],
    related: [r('clerk'), r('admin_officer', 'supervisory')] },

  // ── Technology ──
  { key: 'it_specialist', title: 'IT specialist / systems analyst', sector: 'technology', collar: 'white',
    titles: ['information technology specialist', 'it specialist', 'systems analyst', 'it analyst', 'systems administrator', 'network administrator'],
    skills: ['database', 'network', 'systems troubleshooting', 'enterprise systems', 'gis', 'business intelligence', 'reporting', 'vendor management', 'sql'],
    related: [r('help_desk', 'step_down'), r('software_developer')] },
  { key: 'help_desk', title: 'Help desk / IT support technician', sector: 'technology', collar: 'white',
    titles: ['help desk', 'it support', 'desktop support', 'computer technician', 'technical support'],
    skills: ['troubleshooting', 'computer repair', 'password resets', 'hardware', 'customer support'],
    related: [r('it_specialist', 'supervisory')] },
  { key: 'software_developer', title: 'Software developer', sector: 'technology', collar: 'white',
    titles: ['software developer', 'software engineer', 'web developer', 'programmer'],
    skills: ['javascript', 'python', 'coding', 'programming', 'web development'],
    related: [r('it_specialist')] },

  // ── Green energy ──
  { key: 'solar_installer', title: 'Solar PV installer', sector: 'green_energy', collar: 'green',
    titles: ['solar installer', 'solar pv installer', 'solar technician', 'solar installation', 'pv installer'],
    skills: ['solar panels', 'installing solar', 'photovoltaic', 'pv systems', 'racking', 'inverters', 'rooftop'],
    related: [r('electrician'), r('electrical_technician'), r('renewable_technician'), r('lighting_technician'), r('construction_trades'), r('solar_supervisor', 'supervisory')] },
  { key: 'renewable_technician', title: 'Renewable energy / energy systems technician', sector: 'green_energy', collar: 'green',
    titles: ['renewable energy technician', 'energy systems technician', 'wind turbine technician', 'battery storage technician', 'ev charger technician'],
    skills: ['renewable energy', 'battery storage', 'energy systems', 'ev chargers', 'wind turbines'],
    related: [r('solar_installer'), r('electrical_technician'), r('electrician')] },
  { key: 'solar_supervisor', title: 'Solar / electrical crew lead or supervisor', sector: 'green_energy', collar: 'green', supervisory: true,
    titles: ['solar foreman', 'crew lead', 'installation supervisor', 'site supervisor', 'project lead'],
    skills: ['crew supervision', 'project management', 'scheduling crews', 'safety oversight'],
    related: [r('solar_installer', 'step_down'), r('electrician')] },

  // ── Skilled trades / public works ──
  { key: 'electrician', title: 'Electrician', sector: 'skilled_trades', collar: 'blue',
    titles: ['electrician', 'electrical worker', 'journeyman electrician', 'apprentice electrician'],
    skills: ['electrical', 'wiring', 'conduit', 'circuits', 'electrical code', 'nec', 'panels'],
    related: [r('electrical_technician'), r('solar_installer'), r('lighting_technician'), r('maintenance_technician')] },
  { key: 'electrical_technician', title: 'Electrical / electronics technician', sector: 'skilled_trades', collar: 'blue',
    titles: ['electrical technician', 'electronics technician', 'instrumentation technician', 'controls technician'],
    skills: ['electrical/electronic', 'electronic', 'troubleshooting circuits', 'test equipment', 'controls'],
    related: [r('electrician'), r('lighting_technician'), r('renewable_technician')] },
  { key: 'lighting_technician', title: 'Traffic signal & lighting technician', sector: 'public_works', collar: 'blue',
    titles: ['traffic control', 'lighting technician', 'traffic signal technician', 'signal technician', 'street light'],
    skills: ['traffic-signal', 'traffic signal', 'street light', 'signal cabinets', 'aerial lifts', 'imsa'],
    related: [r('electrical_technician'), r('electrician'), r('maintenance_technician')] },
  { key: 'maintenance_technician', title: 'Maintenance / facilities technician', sector: 'skilled_trades', collar: 'blue',
    titles: ['maintenance technician', 'maintenance worker', 'facilities technician', 'building maintenance', 'handyman'],
    skills: ['repairs', 'preventive maintenance', 'facility upkeep', 'hvac', 'plumbing', 'painting'],
    related: [r('electrician'), r('construction_trades'), r('hvac_technician')] },
  { key: 'hvac_technician', title: 'HVAC technician', sector: 'skilled_trades', collar: 'blue',
    titles: ['hvac technician', 'hvac', 'heating and air', 'refrigeration technician'],
    skills: ['hvac', 'heating', 'air conditioning', 'refrigeration', 'ductwork'],
    related: [r('maintenance_technician'), r('electrician')] },
  { key: 'construction_trades', title: 'Construction trades / laborer', sector: 'skilled_trades', collar: 'blue',
    titles: ['construction worker', 'laborer', 'carpenter', 'plumber', 'roofer', 'welder', 'framer'],
    skills: ['construction', 'carpentry', 'framing', 'roofing', 'welding', 'power tools', 'job site'],
    related: [r('maintenance_technician'), r('solar_installer')] },

  // ── Manufacturing & logistics ──
  { key: 'warehouse', title: 'Warehouse / material handling', sector: 'manufacturing_logistics', collar: 'blue',
    titles: ['warehouse', 'warehouse associate', 'material handler', 'forklift operator', 'picker', 'packer', 'shipping and receiving'],
    skills: ['forklift', 'picking', 'packing', 'loading', 'inventory', 'shipping', 'receiving', 'pallet'],
    related: [r('driver'), r('production')] },
  { key: 'driver', title: 'Driver / delivery', sector: 'manufacturing_logistics', collar: 'blue',
    titles: ['driver', 'delivery driver', 'truck driver', 'cdl driver', 'courier'],
    skills: ['cdl', 'delivery', 'driving', 'routes'],
    related: [r('warehouse')] },
  { key: 'production', title: 'Production / manufacturing worker', sector: 'manufacturing_logistics', collar: 'blue',
    titles: ['production worker', 'assembler', 'machine operator', 'manufacturing technician'],
    skills: ['assembly', 'machine operation', 'production line', 'quality control'],
    related: [r('warehouse'), r('maintenance_technician')] },

  // ── Sales & customer service ──
  { key: 'customer_service', title: 'Customer service / retail', sector: 'sales_customer_service', collar: 'service',
    titles: ['customer service representative', 'retail associate', 'cashier', 'sales associate', 'call center'],
    skills: ['customer service', 'cash handling', 'point of sale', 'customer engagement'],
    related: [r('sales_manager', 'supervisory'), r('admin_assistant')] },
  { key: 'sales_manager', title: 'Sales manager', sector: 'sales_customer_service', collar: 'white', supervisory: true,
    titles: ['sales manager', 'sales director', 'store manager', 'sales lead'],
    skills: ['sales leadership', 'team management', 'sales targets', 'crm', 'inventory management'],
    related: [r('customer_service', 'step_down')] },

  // ── Hospitality ──
  { key: 'housekeeping', title: 'Housekeeping / custodial', sector: 'hospitality', collar: 'service',
    titles: ['housekeeper', 'room attendant', 'custodian', 'janitor', 'cleaner'],
    skills: ['cleaning', 'housekeeping', 'laundry', 'sanitation'],
    related: [r('housekeeping_manager', 'supervisory'), r('caregiver')] },
  { key: 'housekeeping_manager', title: 'Housekeeping / hospitality manager', sector: 'hospitality', collar: 'white', supervisory: true,
    titles: ['housekeeping manager', 'executive housekeeper', 'hospitality manager', 'hotel manager'],
    skills: ['housekeeping operations', 'staff training', 'scheduling', 'inventory control', 'budgeting'],
    related: [r('housekeeping', 'step_down')] },
  { key: 'food_service', title: 'Food service / cook', sector: 'hospitality', collar: 'service',
    titles: ['cook', 'line cook', 'prep cook', 'server', 'dishwasher', 'food service worker', 'barista'],
    skills: ['food preparation', 'cooking', 'food safety', 'kitchen'],
    related: [r('housekeeping')] },

  // ── Education & social services ──
  { key: 'education_support', title: 'Education support / paraeducator', sector: 'education_social_services', collar: 'white',
    titles: ['education support specialist', 'paraeducator', 'instructional aide', 'teacher assistant', 'tutor'],
    skills: ['students', 'classroom', 'tutoring', 'instruction', 'education'],
    related: [r('family_support'), r('childcare')] },
  { key: 'family_support', title: 'Family support / case worker', sector: 'education_social_services', collar: 'white',
    titles: ['family support', 'case manager', 'case worker', 'social services', 'family advocate'],
    skills: ['families', 'case management', 'community resources', 'home visits', 'head start'],
    related: [r('education_support'), r('caregiver')] },
  { key: 'childcare', title: 'Childcare / early education', sector: 'education_social_services', collar: 'service',
    titles: ['childcare', 'child care', 'preschool teacher', 'early childhood', 'daycare'],
    skills: ['children', 'early childhood', 'preschool', 'infants'],
    related: [r('education_support'), r('family_support')] },
];

export const OCCUPATION_BY_KEY = new Map(OCCUPATIONS.map((o) => [o.key, o]));

/** Which sector a stated career interest ("healthcare", "the trades", "office work") points at. */
export function sectorFor(interest: string | undefined): Sector | null {
  if (!interest) return null;
  const t = interest.toLowerCase();
  if (/health|medical|nurs|care ?giv|clinic/.test(t)) return 'healthcare';
  if (/trade|construction|electric|plumb|weld|carpent|hvac/.test(t)) return 'skilled_trades';
  if (/solar|renewable|green|energy/.test(t)) return 'green_energy';
  if (/office|admin|clerical|account|bookkeep/.test(t)) return 'administrative';
  if (/tech|it\b|software|comput|cyber/.test(t)) return 'technology';
  if (/warehouse|logistic|manufactur|driv|forklift/.test(t)) return 'manufacturing_logistics';
  if (/sales|retail|customer/.test(t)) return 'sales_customer_service';
  if (/hospitality|hotel|restaurant|food|cook/.test(t)) return 'hospitality';
  if (/educat|teach|school|child|social/.test(t)) return 'education_social_services';
  return null;
}

// Plurals count ("housekeepers", "solar panels" → "solar panel" is not needed, but "electricians" is).
const phrase = (p: string) => new RegExp(`(^|[^a-z])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?($|[^a-z])`, 'i');
const PHRASES = new Map<string, RegExp>();
const re = (p: string) => {
  let x = PHRASES.get(p);
  if (!x) PHRASES.set(p, (x = phrase(p)));
  return x;
};

export type OccupationHit = { key: string; score: number; titleHits: string[]; skillHits: string[] };

/**
 * Scores occupations against a text. A title phrase is strong evidence (3); each distinct skill phrase
 * is weak evidence (1). Returns hits with score ≥ `min`, strongest first.
 */
export function classify(text: string, min = 3): OccupationHit[] {
  // A driver's license is a credential, not the occupation "driver".
  const t = text.toLowerCase().replace(/\s+/g, ' ').replace(/driver'?s licen[cs]e|driving licen[cs]e/g, ' ');
  const hits: OccupationHit[] = [];
  for (const o of OCCUPATIONS) {
    const titleHits = o.titles.filter((p) => re(p).test(t));
    const skillHits = o.skills.filter((p) => re(p).test(t));
    const score = (titleHits.length ? 3 : 0) + skillHits.length;
    if (score >= min) hits.push({ key: o.key, score, titleHits, skillHits });
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** Occupations from a listing: its title decides; the skills column only fills in when the title is unknown. */
export function classifyListing(title: string, body: string): string[] {
  const byTitle = classify(title, 3).map((h) => h.key);
  if (byTitle.length) return byTitle.slice(0, 2);
  return classify(`${title} ${body}`, 3).slice(0, 1).map((h) => h.key);
}

/** Skill phrases (from the taxonomy) that appear in a text — the basis of "skills alignment". */
export function skillsIn(text: string): string[] {
  const t = text.toLowerCase();
  const out = new Set<string>();
  for (const o of OCCUPATIONS) for (const s of o.skills) if (re(s).test(t)) out.add(s);
  return [...out];
}

/** Related occupations of a set, with the kind of move; the occupations themselves are excluded. */
export function relatedOf(keys: string[]): Map<string, RelationKind> {
  const out = new Map<string, RelationKind>();
  for (const k of keys) for (const rel of OCCUPATION_BY_KEY.get(k)?.related ?? []) if (!keys.includes(rel.key) && !out.has(rel.key)) out.set(rel.key, rel.kind);
  return out;
}

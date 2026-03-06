// ─── LinkedIn API Constants ──────────────────────────────────────────────────

export const LINKEDIN_BASE = 'https://www.linkedin.com';
export const VOYAGER_BASE = `${LINKEDIN_BASE}/voyager/api`;

export const RESULTS_PER_PAGE = 25;
export const MAX_RESULTS_PER_QUERY = 2500;

// ─── HTTP Headers for LinkedIn Requests ──────────────────────────────────────
export const LINKEDIN_HEADERS: Record<string, string> = {
    'accept-language': 'en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
    'x-li-lang': 'en_US',
    'x-restli-protocol-version': '2.0.0',
};

// GraphQL query ID for people search (from linkedin-api v2.3.1)
export const SEARCH_QUERY_ID = 'voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0';

// ─── Seniority Level Map ─────────────────────────────────────────────────────
export const SENIORITY_LEVELS: Record<number, string> = {
    100: 'In Training',
    110: 'Entry Level',
    120: 'Senior',
    130: 'Strategic',
    200: 'Entry Level Manager',
    210: 'Experienced Manager',
    220: 'Director',
    300: 'Vice President',
    310: 'CXO',
    320: 'Owner / Partner',
};

// ─── Function / Department Map ───────────────────────────────────────────────
export const FUNCTIONS: Record<number, string> = {
    1: 'Accounting',
    2: 'Administrative',
    3: 'Arts and Design',
    4: 'Business Development',
    5: 'Community and Social Services',
    6: 'Consulting',
    7: 'Education',
    8: 'Engineering',
    9: 'Entrepreneurship',
    10: 'Finance',
    11: 'Healthcare Services',
    12: 'Human Resources',
    13: 'Information Technology',
    14: 'Legal',
    15: 'Marketing',
    16: 'Media and Communication',
    17: 'Military and Protective Services',
    18: 'Operations',
    19: 'Product Management',
    20: 'Program and Project Management',
    21: 'Purchasing',
    22: 'Quality Assurance',
    23: 'Real Estate',
    24: 'Research',
    25: 'Sales',
    26: 'Customer Success and Support',
};

// ─── Company Headcount Map ───────────────────────────────────────────────────
export const COMPANY_HEADCOUNT: Record<string, string> = {
    A: 'Self-employed',
    B: '1-10',
    C: '11-50',
    D: '51-200',
    E: '201-500',
    F: '501-1000',
    G: '1001-5000',
    H: '5001-10000',
    I: '10001+',
};

// ─── Years Filter Map ────────────────────────────────────────────────────────
export const YEARS_AT_COMPANY: Record<number, string> = {
    1: 'Less than 1 year',
    2: '1 to 2 years',
    3: '3 to 5 years',
    4: '6 to 10 years',
    5: 'More than 10 years',
};

export const YEARS_OF_EXPERIENCE: Record<number, string> = {
    1: 'Less than 1 year',
    2: '1 to 2 years',
    3: '3 to 5 years',
    4: '6 to 10 years',
    5: 'More than 10 years',
};

// ─── Months Array ────────────────────────────────────────────────────────────
export const MONTHS = [
    '', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// ─── Common Email Domains for Verification ───────────────────────────────────
export const FREE_EMAIL_PROVIDERS = new Set([
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com', 'yandex.com',
    'live.com', 'msn.com', 'me.com', 'gmx.com', 'fastmail.com',
]);

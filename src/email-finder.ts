import { log } from 'apify';
import { FREE_EMAIL_PROVIDERS } from './constants.js';
import { delay } from './utils.js';
import * as dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

// ─── Email Pattern Generation ────────────────────────────────────────────────

/** Common email patterns used by businesses. */
const EMAIL_PATTERNS = [
    (first: string, last: string, domain: string) => `${first}@${domain}`,
    (first: string, last: string, domain: string) => `${first}.${last}@${domain}`,
    (first: string, last: string, domain: string) => `${first}${last}@${domain}`,
    (first: string, last: string, domain: string) => `${first[0]}${last}@${domain}`,
    (first: string, last: string, domain: string) => `${first[0]}.${last}@${domain}`,
    (first: string, last: string, domain: string) => `${last}@${domain}`,
    (first: string, last: string, domain: string) => `${first}_${last}@${domain}`,
    (first: string, last: string, domain: string) => `${first}-${last}@${domain}`,
    (first: string, last: string, domain: string) => `${last}.${first}@${domain}`,
    (first: string, last: string, domain: string) => `${last}${first}@${domain}`,
    (first: string, last: string, domain: string) => `${last}${first[0]}@${domain}`,
];

/** Clean name for email generation. */
function cleanName(name: string): string {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
        .replace(/[^a-z]/g, '');
}

/** Extract domain from website URL. */
export function extractDomain(website: string): string {
    if (!website) return '';
    try {
        const url = website.startsWith('http') ? website : `https://${website}`;
        const parsed = new globalThis.URL(url);
        const domain = parsed.hostname.replace(/^www\./, '');
        // Filter out free email providers and social domains
        if (FREE_EMAIL_PROVIDERS.has(domain) || domain.includes('linkedin.com') || domain.includes('facebook.com')) {
            return '';
        }
        return domain;
    } catch {
        return '';
    }
}

// ─── MX Record Checking ─────────────────────────────────────────────────────

/** Cache for MX record lookups. */
const mxCache = new Map<string, boolean>();

/** Check if a domain has MX records (can receive email). */
async function hasMxRecords(domain: string): Promise<boolean> {
    if (mxCache.has(domain)) {
        return mxCache.get(domain)!;
    }

    try {
        const records = await resolveMx(domain);
        const hasMx = records.length > 0;
        mxCache.set(domain, hasMx);
        return hasMx;
    } catch {
        mxCache.set(domain, false);
        return false;
    }
}

// ─── Email Finder ────────────────────────────────────────────────────────────

export interface EmailResult {
    email: string | null;
    emailSource: string | null;
    allEmails: string[];
}

/**
 * Find a probable email address for a person.
 * Uses name + company domain pattern matching and MX validation.
 */
export async function findEmail(
    firstName: string,
    lastName: string,
    companyDomain: string,
): Promise<EmailResult> {
    const result: EmailResult = {
        email: null,
        emailSource: null,
        allEmails: [],
    };

    if (!firstName || !lastName || !companyDomain) {
        return result;
    }

    const cleanFirst = cleanName(firstName);
    const cleanLast = cleanName(lastName);

    if (!cleanFirst || !cleanLast) {
        return result;
    }

    // Check if domain has MX records
    const hasMx = await hasMxRecords(companyDomain);
    if (!hasMx) {
        log.debug(`No MX records for ${companyDomain}, skipping email generation`);
        return result;
    }

    // Generate candidate emails using common patterns
    const candidates: string[] = [];
    for (const pattern of EMAIL_PATTERNS) {
        try {
            const email = pattern(cleanFirst, cleanLast, companyDomain);
            if (email && !candidates.includes(email)) {
                candidates.push(email);
            }
        } catch {
            // Skip invalid patterns
        }
    }

    result.allEmails = candidates;

    // The most common pattern is first.last@domain
    if (candidates.length > 0) {
        result.email = candidates[1] || candidates[0]; // first.last or first
        result.emailSource = 'pattern-match';
    }

    return result;
}

/**
 * Find email using profile's own contact info or known emails.
 */
export function findEmailFromProfile(profileData: any): EmailResult {
    const result: EmailResult = {
        email: null,
        emailSource: null,
        allEmails: [],
    };

    // Check if email is already in profile data
    if (profileData.emailAddress) {
        result.email = profileData.emailAddress;
        result.emailSource = 'profile';
        result.allEmails.push(profileData.emailAddress);
        return result;
    }

    // Check contact info
    if (profileData.contactInfo?.emailAddress) {
        result.email = profileData.contactInfo.emailAddress;
        result.emailSource = 'contact-info';
        result.allEmails.push(profileData.contactInfo.emailAddress);
        return result;
    }

    return result;
}

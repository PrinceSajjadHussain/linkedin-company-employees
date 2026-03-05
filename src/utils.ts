import { log } from 'apify';
import { MONTHS } from './constants.js';
import type { DateInfo, LocationInfo } from './types.js';

// ─── URL Parsing ─────────────────────────────────────────────────────────────

/** Extract company universal name from a LinkedIn URL or return the input as a name. */
export function parseCompanyIdentifier(input: string): string {
    const trimmed = input.trim();
    // Match LinkedIn company URL patterns
    const match = trimmed.match(/linkedin\.com\/company\/([^/?#]+)/i);
    if (match) return match[1].toLowerCase();
    // Treat as a company name
    return trimmed;
}

/** Build a LinkedIn company URL from a universal name or numeric ID. */
export function buildCompanyUrl(universalNameOrId: string): string {
    return `https://www.linkedin.com/company/${universalNameOrId}/`;
}

/** Build a LinkedIn profile URL from a public identifier. */
export function buildProfileUrl(publicIdentifier: string): string {
    return `https://www.linkedin.com/in/${publicIdentifier}`;
}

// ─── JSON Extraction from HTML ───────────────────────────────────────────────

/** Extract embedded JSON from LinkedIn HTML pages (e.g., from <code> tags or script vars). */
export function extractJsonFromHtml(html: string, marker: string): any | null {
    try {
        const idx = html.indexOf(marker);
        if (idx === -1) return null;
        const start = html.indexOf('{', idx);
        if (start === -1) return null;

        let depth = 0;
        let end = start;
        for (let i = start; i < html.length; i++) {
            if (html[i] === '{') depth++;
            else if (html[i] === '}') depth--;
            if (depth === 0) {
                end = i + 1;
                break;
            }
        }
        return JSON.parse(html.slice(start, end));
    } catch {
        return null;
    }
}

/** Extract all embedded JSON objects from LinkedIn <code> tags. */
export function extractCodeJsonBlobs(html: string): any[] {
    const results: Array<any> = [];
    const codeRegex = /<code[^>]*>([\s\S]*?)<\/code>/gi;
    let match: RegExpExecArray | null;
    while ((match = codeRegex.exec(html)) !== null) {
        try {
            const decoded = decodeHtmlEntities(match[1]);
            const parsed = JSON.parse(decoded);
            results.push(parsed);
        } catch {
            // Not valid JSON, skip
        }
    }
    return results;
}

// ─── HTML Entity Decoding ────────────────────────────────────────────────────

export function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

export function formatDateInfo(obj: any): DateInfo | undefined {
    if (!obj) return undefined;
    const month = obj.month ? MONTHS[obj.month] || '' : '';
    const year = obj.year || '';
    const text = month && year ? `${month} ${year}` : `${year}`;
    if (!text.trim()) return undefined;
    return {
        ...(month ? { month } : {}),
        ...(year ? { year: Number(year) } : {}),
        text: text.trim(),
    };
}

export function formatDuration(startDate?: DateInfo, endDate?: DateInfo): string {
    if (!startDate?.year) return '';
    const startMonth = startDate.month ? MONTHS.indexOf(startDate.month) : 1;
    const startYear = startDate.year;

    let endMonth: number;
    let endYear: number;
    if (endDate?.text === 'Present' || !endDate?.year) {
        const now = new Date();
        endMonth = now.getMonth() + 1;
        endYear = now.getFullYear();
    } else {
        endMonth = endDate.month ? MONTHS.indexOf(endDate.month) : 12;
        endYear = endDate.year;
    }

    let totalMonths = (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
    if (totalMonths < 1) totalMonths = 1;

    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;

    const parts: Array<string> = [];
    if (years > 0) parts.push(`${years} yr${years > 1 ? 's' : ''}`);
    if (months > 0) parts.push(`${months} mo${months > 1 ? 's' : ''}`);
    return parts.join(' ') || '1 mo';
}

// ─── Location Parsing ────────────────────────────────────────────────────────

export function parseLocation(locationText: string | undefined): LocationInfo {
    if (!locationText) return {};
    return {
        linkedinText: locationText,
        parsed: {
            text: locationText,
        },
    };
}

// ─── Count Parsing ───────────────────────────────────────────────────────────

export function parseCount(text: string | undefined): number {
    if (!text) return 0;
    const cleaned = text.replace(/[,\s]/g, '');
    const match = cleaned.match(/([\d.]+)\s*([KkMm])?/);
    if (!match) return 0;
    let num = parseFloat(match[1]);
    const suffix = (match[2] || '').toUpperCase();
    if (suffix === 'K') num *= 1000;
    if (suffix === 'M') num *= 1000000;
    return Math.round(num);
}

// ─── Cookie Parsing ──────────────────────────────────────────────────────────

export function extractCsrfToken(cookies: string): string {
    const match = cookies.match(/JSESSIONID="?([^";]+)"?/);
    return match ? match[1] : '';
}

export function parseCookies(setCookieHeaders: string[]): string {
    return setCookieHeaders
        .map((h) => h.split(';')[0])
        .join('; ');
}

// ─── Delay ───────────────────────────────────────────────────────────────────

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random delay between min and max milliseconds. */
export function randomDelay(min: number, max: number): Promise<void> {
    return delay(min + Math.random() * (max - min));
}

// ─── Retry Helper ────────────────────────────────────────────────────────────

export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    delayMs: number = 2000,
    label: string = 'operation',
): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            if (attempt === maxRetries) throw err;
            log.warning(`${label} failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${delayMs}ms...`);
            await delay(delayMs * attempt);
        }
    }
    throw new Error(`${label} failed after ${maxRetries} attempts`);
}

// ─── Voyager Data Extraction Helpers ─────────────────────────────────────────

/** Navigate nested Voyager API response to find entities by recipe type. */
export function findIncludedByType(included: any[], type: string): any[] {
    if (!Array.isArray(included)) return [];
    return included.filter((item) => {
        const recipe = item.$type || item['$type'] || '';
        return recipe.includes(type);
    });
}

/** Deep-get a value from a nested object using a dot-separated path. */
export function deepGet(obj: any, path: string, defaultValue: any = undefined): any {
    const keys = path.split('.');
    let current = obj;
    for (const key of keys) {
        if (current == null) return defaultValue;
        current = current[key];
    }
    return current ?? defaultValue;
}

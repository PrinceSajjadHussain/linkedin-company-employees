import { log } from 'apify';
import { ProxyConfiguration } from 'apify';
import { gotScraping } from 'got-scraping';
import {
    LINKEDIN_BASE,
    VOYAGER_BASE,
    LINKEDIN_HEADERS,
    RESULTS_PER_PAGE,
    MONTHS,
} from './constants.js';
import {
    extractCsrfToken,
    parseCookies,
    delay,
    randomDelay,
    withRetry,
    parseLocation,
    formatDateInfo,
    formatDuration,
    buildProfileUrl,
    buildCompanyUrl,
    findIncludedByType,
    decodeHtmlEntities,
    extractCodeJsonBlobs,
} from './utils.js';
import type {
    CompanyInfo,
    ProfileData,
    ProfileShort,
    SearchResult,
    PaginationInfo,
    SearchQuery,
    ExperienceEntry,
    EducationEntry,
    CertificationEntry,
    SkillEntry,
    CurrentPosition,
} from './types.js';

// ─── LinkedIn Client ─────────────────────────────────────────────────────────

export class LinkedInClient {
    private csrfToken = '';
    private cookies = '';
    private liAtCookie = '';
    private proxyConfig?: ProxyConfiguration;
    private sessionValid = false;

    constructor(liAtCookie: string, proxyConfig?: ProxyConfiguration) {
        this.liAtCookie = liAtCookie;
        this.proxyConfig = proxyConfig;
    }

    // ─── HTTP Layer (got-scraping with proxy) ────────────────────────────────

    /** Make an HTTP GET request using got-scraping with proxy support. */
    private async httpGet(
        url: string,
        headers: Record<string, string>,
    ): Promise<{ statusCode: number; body: string; setCookies: string[] }> {
        const proxyUrl = this.proxyConfig
            ? await this.proxyConfig.newUrl()
            : undefined;

        const response = await gotScraping({
            url,
            method: 'GET',
            headers,
            proxyUrl,
            followRedirect: true,
            throwHttpErrors: false,
            responseType: 'text',
        });

        const rawSetCookie = response.headers['set-cookie'];
        const setCookies: string[] = Array.isArray(rawSetCookie)
            ? rawSetCookie
            : rawSetCookie
              ? [rawSetCookie]
              : [];

        return {
            statusCode: response.statusCode,
            body: response.body as string,
            setCookies,
        };
    }

    // ─── Session Initialization ──────────────────────────────────────────────

    /** Initialize an authenticated session using the li_at cookie. */
    async initSession(): Promise<void> {
        log.info('Initializing LinkedIn authenticated session...');

        // Set up cookies with the provided li_at token
        this.cookies = `li_at=${this.liAtCookie}; li_gc=1; lang=en_US`;

        // Fetch LinkedIn to get JSESSIONID / CSRF token
        const resp = await this.httpGet(`${LINKEDIN_BASE}/feed/`, {
            'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            cookie: this.cookies,
        });

        log.debug(`Init session response status: ${resp.statusCode}`);

        // Extract JSESSIONID from set-cookie headers
        for (const sc of resp.setCookies) {
            const jsMatch = sc.match(/JSESSIONID="?([^";]+)/);
            if (jsMatch) {
                this.csrfToken = jsMatch[1].replace(/"/g, '');
                break;
            }
        }

        // Fallback: look in the response body
        if (!this.csrfToken) {
            const allCookies = parseCookies(resp.setCookies);
            this.csrfToken = extractCsrfToken(allCookies || this.cookies);
        }
        if (!this.csrfToken) {
            const match = resp.body.match(/JSESSIONID.*?["']([^"']+)["']/);
            if (match) this.csrfToken = match[1].replace(/"/g, '');
        }

        // Merge all set-cookie values with our cookies
        const allCookies = parseCookies(resp.setCookies);
        if (allCookies) {
            this.cookies = `li_at=${this.liAtCookie}; ${allCookies}`;
        }
        if (this.csrfToken && !this.cookies.includes('JSESSIONID')) {
            this.cookies += `; JSESSIONID="${this.csrfToken}"`;
        }

        this.sessionValid = !!this.csrfToken;
        log.info(
            `Session initialized. CSRF token: ${this.csrfToken ? 'obtained' : 'MISSING'}`,
        );
        log.debug(`Session cookies length: ${this.cookies.length}`);

        if (!this.sessionValid) {
            log.warning(
                'Could not obtain CSRF token. The li_at cookie may be invalid or expired.',
            );
        }
    }

    // ─── Voyager API Helpers ─────────────────────────────────────────────────

    /** Get default headers for Voyager API requests. */
    private getHeaders(): Record<string, string> {
        return {
            ...LINKEDIN_HEADERS,
            'csrf-token': this.csrfToken,
            cookie: this.cookies,
            'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        };
    }

    /** Make a Voyager API request. */
    private async voyagerGet(endpoint: string): Promise<any> {
        const url = `${VOYAGER_BASE}/${endpoint}`;
        const resp = await this.httpGet(url, this.getHeaders());

        log.debug(
            `Voyager GET ${resp.statusCode}: ${endpoint.substring(0, 120)}`,
        );

        if (resp.statusCode === 429) throw new Error('RATE_LIMITED');

        if (resp.statusCode === 401 || resp.statusCode === 403) {
            log.debug(
                `Auth error body (first 300): ${resp.body.substring(0, 300)}`,
            );
            throw new Error(`AUTH_REQUIRED: ${resp.statusCode}`);
        }

        if (resp.statusCode >= 400) {
            log.debug(
                `Error body (first 300): ${resp.body.substring(0, 300)}`,
            );
            throw new Error(`Voyager API error: ${resp.statusCode}`);
        }

        try {
            return JSON.parse(resp.body);
        } catch {
            log.debug(
                `Non-JSON response (first 300): ${resp.body.substring(0, 300)}`,
            );
            throw new Error('Invalid JSON response from Voyager API');
        }
    }

    /** Make an HTML page request. */
    private async htmlGet(url: string): Promise<string> {
        const resp = await this.httpGet(url, {
            'user-agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.9',
            cookie: this.cookies,
        });

        if (resp.statusCode === 429) throw new Error('RATE_LIMITED');
        return resp.body;
    }

    // ─── Company Resolution ──────────────────────────────────────────────────

    /** Resolve a company name or URL to a CompanyInfo object. */
    async resolveCompany(nameOrUrl: string): Promise<CompanyInfo> {
        const identifier = nameOrUrl.trim().replace(/\/$/, '');
        const urlMatch = identifier.match(/linkedin\.com\/company\/([^/?#]+)/i);
        const universalName = urlMatch
            ? urlMatch[1].toLowerCase()
            : identifier.toLowerCase().replace(/\s+/g, '-');

        log.info(`Resolving company: ${universalName}`);

        // Try Voyager API with multiple decoration IDs
        const companyDecIds = [40, 35, 28, 20, 12];
        for (const decId of companyDecIds) {
            try {
                const data = await this.voyagerGet(
                    `organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-${decId}&q=universalName&universalName=${encodeURIComponent(universalName)}`,
                );

                if (data?.elements?.[0]) {
                    const company = data.elements[0];
                    const companyId = String(
                        company.entityUrn?.split(':').pop() ||
                            company.objectUrn?.split(':').pop() ||
                            '',
                    );
                    log.info(
                        `Voyager API resolved (decId=${decId}): id=${companyId}, name="${company.name}", staff=${company.staffCount}`,
                    );
                    return {
                        universalName: company.universalName || universalName,
                        companyId,
                        name: company.name || universalName,
                        domain:
                            company.companyPageUrl || company.websiteUrl || '',
                        employeeCount:
                            company.staffCount ||
                            company.staffCountRange?.start ||
                            0,
                        linkedinUrl: buildCompanyUrl(
                            company.universalName || universalName,
                        ),
                    };
                }
            } catch (err: any) {
                log.debug(`Voyager company lookup (decId=${decId}) failed: ${err.message}`);
            }
        }

        // Try organization dash API (newer endpoint)
        try {
            const data = await this.voyagerGet(
                `organization/dash/companies?decorationId=com.linkedin.voyager.dash.deco.organization.MiniCompany-2&q=universalName&universalName=${encodeURIComponent(universalName)}`,
            );
            if (data?.elements?.[0]) {
                const company = data.elements[0];
                const companyId = String(
                    company.entityUrn?.split(':').pop() ||
                        company.objectUrn?.split(':').pop() ||
                        '',
                );
                log.info(
                    `Dash API resolved: id=${companyId}, name="${company.name}"`,
                );
                return {
                    universalName: company.universalName || universalName,
                    companyId,
                    name: company.name || universalName,
                    domain: company.companyPageUrl || company.websiteUrl || '',
                    employeeCount: company.staffCount || 0,
                    linkedinUrl: buildCompanyUrl(
                        company.universalName || universalName,
                    ),
                };
            }
        } catch (err: any) {
            log.debug(`Dash company lookup failed: ${err.message}`);
        }

        // Fallback: scrape the company page HTML
        try {
            const html = await this.htmlGet(
                `${LINKEDIN_BASE}/company/${encodeURIComponent(universalName)}/`,
            );

            let companyId = '';
            let companyName = universalName;
            let employeeCount = 0;
            let domain = '';

            // Look for fsd_company URN
            const urnMatch = html.match(/urn:li:fsd_company:(\d+)/);
            if (urnMatch) companyId = urnMatch[1];

            // Also try other patterns
            if (!companyId) {
                const numMatch = html.match(
                    /companyId['":\s]+["']?(\d{4,})["']?/,
                );
                if (numMatch) companyId = numMatch[1];
            }

            // Extract name
            const titleMatch = html.match(/<title>([^|<–]+)/);
            if (titleMatch) {
                companyName = decodeHtmlEntities(titleMatch[1].trim());
                // Remove trailing " | LinkedIn" etc.
                companyName = companyName
                    .replace(/\s*[|–-]\s*LinkedIn.*$/i, '')
                    .trim();
            }

            // Extract employee count
            const staffMatch = html.match(
                /(\d[\d,]+)\s+employees?\s+on\s+LinkedIn/i,
            );
            if (staffMatch) {
                employeeCount = parseInt(
                    staffMatch[1].replace(/,/g, ''),
                    10,
                );
            }

            // Try JSON-LD
            const jsonLdMatch = html.match(
                /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
            );
            if (jsonLdMatch) {
                try {
                    const jsonLd = JSON.parse(jsonLdMatch[1]);
                    if (jsonLd.name) companyName = jsonLd.name;
                    if (jsonLd.url) domain = jsonLd.url;
                    if (jsonLd.numberOfEmployees?.value)
                        employeeCount = jsonLd.numberOfEmployees.value;
                } catch {
                    /* ignore */
                }
            }

            log.info(
                `HTML resolved: id=${companyId}, name="${companyName}", employees=${employeeCount}`,
            );

            return {
                universalName,
                companyId,
                name: companyName,
                domain,
                employeeCount,
                linkedinUrl: buildCompanyUrl(universalName),
            };
        } catch (err: any) {
            log.warning(
                `Failed to resolve company "${nameOrUrl}": ${err.message}`,
            );
            return {
                universalName,
                companyId: '',
                name: nameOrUrl,
                linkedinUrl: buildCompanyUrl(universalName),
            };
        }
    }

    // ─── Employee Search ─────────────────────────────────────────────────────

    /** Build Voyager search URL with filters. */
    private buildSearchUrl(query: SearchQuery, page: number): string {
        const start = (page - 1) * RESULTS_PER_PAGE;

        // Build query parameters
        const qp: string[] = [];

        if (query.currentCompanies?.length) {
            qp.push(
                `currentCompany:List(${query.currentCompanies.join(',')})`,
            );
        }
        if (query.locations?.length) {
            qp.push(`geoUrn:List(${query.locations.join(',')})`);
        }
        if (query.currentJobTitles?.length) {
            qp.push(`title:List(${query.currentJobTitles.join(',')})`);
        }
        if (query.industryIds?.length) {
            qp.push(`industry:List(${query.industryIds.join(',')})`);
        }
        if (query.seniorityLevelIds?.length) {
            qp.push(
                `seniorityLevel:List(${query.seniorityLevelIds.join(',')})`,
            );
        }
        if (query.functionIds?.length) {
            qp.push(`function:List(${query.functionIds.join(',')})`);
        }
        if (query.yearsAtCurrentCompanyIds?.length) {
            qp.push(
                `yearsAtCurrentCompany:List(${query.yearsAtCurrentCompanyIds.join(',')})`,
            );
        }
        if (query.yearsOfExperienceIds?.length) {
            qp.push(
                `yearsOfExperience:List(${query.yearsOfExperienceIds.join(',')})`,
            );
        }
        if (query.companyHeadcount?.length) {
            qp.push(
                `companySize:List(${query.companyHeadcount.join(',')})`,
            );
        }

        qp.push('resultType:List(PEOPLE)');

        const keywords = query.keywords
            ? `,keywords:${encodeURIComponent(query.keywords)}`
            : '';

        return `search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-228&origin=FACETED_SEARCH&q=all&query=(flagshipSearchIntent:SEARCH_SRP${keywords},(includeFiltersInResponse:true),queryParameters:(${qp.join(',')}))&count=${RESULTS_PER_PAGE}&start=${start}`;
    }

    /** Log the structure of a Voyager API response for debugging. */
    private logResponseStructure(data: any, label: string): void {
        if (!data) {
            log.info(`[${label}] Response is null/undefined`);
            return;
        }
        const keys = Object.keys(data);
        const includedCount = data?.included?.length || 0;
        const elementsCount = data?.elements?.length || 0;
        const types = new Set<string>();
        for (const item of data?.included || []) {
            const t = item['$type'] || item._type || '';
            if (t) types.add(t.split('.').pop() || t);
        }
        log.info(
            `[${label}] keys=${JSON.stringify(keys)}, included=${includedCount}, elements=${elementsCount}, types=[${[...types].join(', ')}]`,
        );
    }

    /** Search for company employees using Voyager API. */
    async searchEmployees(
        query: SearchQuery,
        page: number,
    ): Promise<SearchResult> {
        const endpoint = this.buildSearchUrl(query, page);
        log.debug(`Search endpoint: ${endpoint.substring(0, 200)}`);

        // Decoration IDs to try (newest → oldest)
        const decorationIds = [228, 218, 207, 200, 193, 186, 174, 165, 158];
        // Origins to try
        const origins = ['FACETED_SEARCH', 'COMPANY_PAGE_CANNED_SEARCH', 'SWITCH_SEARCH_VERTICAL', 'GLOBAL_SEARCH_HEADER'];

        let bestResult: SearchResult | null = null;

        // Try primary endpoint first
        try {
            const data = await withRetry(
                () => this.voyagerGet(endpoint),
                2,
                3000,
                `Search page ${page}`,
            );

            this.logResponseStructure(data, 'primary');
            const result = this.parseSearchResults(data, page);
            if (result.profiles.length > 0) return result;
            // Keep result for pagination info even if profiles are empty
            if (result.pagination.totalElements > 0) bestResult = result;
        } catch (err: any) {
            if (err.message === 'RATE_LIMITED') throw err;
            log.warning(`Primary Voyager search failed: ${err.message}`);
        }

        // Try alternate decoration IDs
        for (const decId of decorationIds) {
            try {
                log.debug(`Trying decoration ID ${decId}...`);
                const altEndpoint = endpoint.replace(
                    /SearchClusterCollection-\d+/,
                    `SearchClusterCollection-${decId}`,
                );
                const data = await this.voyagerGet(altEndpoint);
                this.logResponseStructure(data, `decId-${decId}`);
                const result = this.parseSearchResults(data, page);
                if (result.profiles.length > 0) return result;
                if (!bestResult && result.pagination.totalElements > 0) {
                    bestResult = result;
                }
            } catch (err: any) {
                if (err.message === 'RATE_LIMITED') throw err;
                log.debug(`Decoration ${decId} failed: ${err.message}`);
            }
        }

        // Try alternate origins with a mid-range decoration ID
        for (const origin of origins) {
            try {
                log.debug(`Trying origin ${origin}...`);
                const altEndpoint = endpoint
                    .replace(/origin=[A-Z_]+/, `origin=${origin}`)
                    .replace(/SearchClusterCollection-\d+/, 'SearchClusterCollection-207');
                const data = await this.voyagerGet(altEndpoint);
                this.logResponseStructure(data, `origin-${origin}`);
                const result = this.parseSearchResults(data, page);
                if (result.profiles.length > 0) return result;
            } catch (err: any) {
                if (err.message === 'RATE_LIMITED') throw err;
                log.debug(`Origin ${origin} failed: ${err.message}`);
            }
        }

        // Try without includeFiltersInResponse (older format)
        try {
            log.debug('Trying search without includeFiltersInResponse...');
            const cleanEndpoint = endpoint
                .replace(/,\(includeFiltersInResponse:true\)/, '')
                .replace(/SearchClusterCollection-\d+/, 'SearchClusterCollection-207');
            const data = await this.voyagerGet(cleanEndpoint);
            this.logResponseStructure(data, 'no-filters');
            const result = this.parseSearchResults(data, page);
            if (result.profiles.length > 0) return result;
        } catch (err: any) {
            if (err.message === 'RATE_LIMITED') throw err;
            log.debug(`No-filters search failed: ${err.message}`);
        }

        // HTML fallback
        log.info('Trying HTML search fallback...');
        try {
            const htmlResult = await this.searchEmployeesHtml(query, page);
            if (htmlResult.profiles.length > 0) return htmlResult;
        } catch (err: any) {
            log.warning(`HTML search fallback failed: ${err.message}`);
        }

        // Return best available result (even if empty)
        if (bestResult) return bestResult;
        return {
            profiles: [],
            pagination: {
                pageNumber: page,
                totalElements: 0,
                totalPages: 0,
                itemsPerPage: RESULTS_PER_PAGE,
            },
        };
    }

    /** Fallback: search via HTML page. */
    private async searchEmployeesHtml(
        query: SearchQuery,
        page: number,
    ): Promise<SearchResult> {
        const start = (page - 1) * RESULTS_PER_PAGE;
        const params = new URLSearchParams();

        if (query.currentCompanies?.length) {
            params.set(
                'currentCompany',
                JSON.stringify(query.currentCompanies),
            );
        }
        if (query.keywords) {
            params.set('keywords', query.keywords);
        }
        if (query.locations?.length) {
            params.set('geoUrn', JSON.stringify(query.locations));
        }
        params.set('origin', 'COMPANY_PAGE_CANNED_SEARCH');
        params.set('start', String(start));

        const searchUrl = `${LINKEDIN_BASE}/search/results/people/?${params.toString()}`;
        const html = await this.htmlGet(searchUrl);

        const profiles: Array<ProfileShort> = [];
        let totalCount = 0;

        // Extract data from embedded JSON in <code> tags and <script> tags
        const blobs = extractCodeJsonBlobs(html);

        // Also try to extract from script tags with JSON data
        const scriptRegex = /<script[^>]*type="application\/json"[^>]*>(\{[\s\S]*?\})<\/script>/gi;
        let scriptMatch: RegExpExecArray | null;
        while ((scriptMatch = scriptRegex.exec(html)) !== null) {
            try {
                const parsed = JSON.parse(scriptMatch[1]);
                blobs.push(parsed);
            } catch { /* skip */ }
        }

        for (const blob of blobs) {
            if (!blob?.included) continue;

            // Try multiple entity types
            const profileEntityTypes = ['MiniProfile', 'Profile', 'SearchProfile', 'EntityResult'];
            for (const entityType of profileEntityTypes) {
                const profileEntities = findIncludedByType(
                    blob.included,
                    entityType,
                );
                for (const p of profileEntities) {
                    const pubId = p.publicIdentifier || p.navigationUrl?.match(/\/in\/([^/?]+)/)?.[1] || '';
                    if (
                        pubId &&
                        pubId !== 'UNKNOWN' &&
                        !profiles.some(pr => pr.publicIdentifier === pubId)
                    ) {
                        profiles.push({
                            publicIdentifier: pubId,
                            linkedinUrl: buildProfileUrl(pubId),
                            firstName: p.firstName || p.title?.text?.split(' ')[0] || '',
                            lastName: p.lastName || p.title?.text?.split(' ').slice(1).join(' ') || '',
                            headline: p.occupation || p.headline || p.primarySubtitle?.text || '',
                            location: parseLocation(p.locationName || p.secondarySubtitle?.text),
                            photo: p.picture?.rootUrl
                                ? `${p.picture.rootUrl}${p.picture.artifacts?.[p.picture.artifacts.length - 1]?.fileIdentifyingUrlPathSegment || ''}`
                                : p.image?.attributes?.[0]?.detailData?.nonEntityProfilePicture?.vectorImage?.rootUrl || null,
                        });
                    }
                }
            }

            if (blob.data?.paging?.total) {
                totalCount = blob.data.paging.total;
            } else if (blob.data?.metadata?.totalResultCount) {
                totalCount = blob.data.metadata.totalResultCount;
            }
        }

        log.info(`HTML search: found ${profiles.length} profiles, totalCount=${totalCount}`);

        const totalPages = Math.ceil(totalCount / RESULTS_PER_PAGE);
        return {
            profiles,
            pagination: {
                pageNumber: page,
                totalElements: totalCount,
                totalPages,
                itemsPerPage: RESULTS_PER_PAGE,
            },
        };
    }

    /** Extract a profile from an entity-like object (EntityResult, SearchResult, etc.). */
    private extractProfileFromEntity(entity: any): ProfileShort | null {
        // Try to get public identifier from various locations
        const publicId =
            entity.publicIdentifier ||
            entity.navigationUrl?.match(/\/in\/([^/?]+)/)?.[1] ||
            entity.entityUrn?.match(/fsd_profile:([^,)]+)/)?.[1] ||
            entity.trackingUrn?.match(/member:(\d+)/)?.[1] ||
            entity.targetUrn?.match(/member:(\d+)/)?.[1] ||
            '';

        if (!publicId || publicId === 'UNKNOWN') return null;

        // Extract name from title or direct fields
        const title = entity.title?.text || '';
        const firstName = entity.firstName || (title ? title.split(' ')[0] : '') || '';
        const lastName = entity.lastName || (title ? title.split(' ').slice(1).join(' ') : '') || '';

        // Extract headline
        const headline =
            entity.occupation ||
            entity.headline ||
            entity.primarySubtitle?.text ||
            entity.headline?.text ||
            entity.summary?.text ||
            '';

        // Extract location
        const locationText =
            entity.locationName ||
            entity.secondarySubtitle?.text ||
            entity.subline?.text ||
            '';

        // Extract photo
        const photoUrl =
            entity.picture?.rootUrl
                ? `${entity.picture.rootUrl}${entity.picture.artifacts?.[entity.picture.artifacts.length - 1]?.fileIdentifyingUrlPathSegment || ''}`
                : entity.image?.attributes?.[0]?.detailData
                      ?.nonEntityProfilePicture?.vectorImage?.rootUrl ||
                  entity.image?.attributes?.[0]?.detailData
                      ?.profilePicture?.vectorImage?.rootUrl ||
                  null;

        return {
            publicIdentifier: publicId,
            linkedinUrl: buildProfileUrl(publicId),
            firstName,
            lastName,
            headline,
            location: parseLocation(locationText),
            photo: photoUrl,
        };
    }

    /** Parse Voyager API search response into SearchResult. */
    private parseSearchResults(data: any, page: number): SearchResult {
        const profiles: Array<ProfileShort> = [];
        const seenIds = new Set<string>();
        let totalCount = 0;

        // Extract total count from various locations
        if (data?.paging?.total != null) totalCount = data.paging.total;
        else if (data?.metadata?.totalResultCount != null)
            totalCount = data.metadata.totalResultCount;

        const included = data?.included || [];

        // Log all entity types found in included for debugging
        if (included.length > 0) {
            const typeCounts: Record<string, number> = {};
            for (const item of included) {
                const t = (item['$type'] || item._type || 'unknown').split('.').pop() || 'unknown';
                typeCounts[t] = (typeCounts[t] || 0) + 1;
            }
            log.info(`Response entity types: ${JSON.stringify(typeCounts)}`);
        }

        const addProfile = (p: ProfileShort | null) => {
            if (p && p.publicIdentifier && !seenIds.has(p.publicIdentifier)) {
                seenIds.add(p.publicIdentifier);
                profiles.push(p);
            }
        };

        // Method 1: MiniProfile / Profile entities in included
        const profileTypes = ['MiniProfile', 'Profile', 'MemberProfile'];
        for (const ptype of profileTypes) {
            const entities = findIncludedByType(included, ptype);
            if (entities.length > 0) {
                log.info(`Found ${entities.length} ${ptype} entities`);
                for (const mp of entities) {
                    addProfile(this.extractProfileFromEntity(mp));
                }
            }
        }

        // Method 2: EntityResult / SearchProfile / ProfileResult in included
        if (profiles.length === 0) {
            const resultTypes = ['EntityResult', 'SearchProfile', 'ProfileResult', 'SearchHit', 'EntityResultViewModel'];
            for (const item of included) {
                const t = item['$type'] || item._type || '';
                if (resultTypes.some(rt => t.includes(rt))) {
                    addProfile(this.extractProfileFromEntity(item));
                }
            }
            if (profiles.length > 0) {
                log.info(`Found ${profiles.length} profiles from EntityResult-type entities`);
            }
        }

        // Method 3: elements → items → entityResult (cluster-based response)
        if (profiles.length === 0 && data?.elements) {
            for (const cluster of data.elements) {
                const items =
                    cluster?.items || cluster?.results || cluster?.elements || [];
                for (const item of items) {
                    const entity =
                        item?.item?.entityResult ||
                        item?.item?.entity ||
                        item?.entityResult ||
                        item?.entity ||
                        item;
                    addProfile(this.extractProfileFromEntity(entity));
                }

                // Extract total from cluster metadata
                if (cluster?.metadata?.totalResultCount)
                    totalCount = Math.max(totalCount, cluster.metadata.totalResultCount);
                if (cluster?.paging?.total)
                    totalCount = Math.max(totalCount, cluster.paging.total);
            }
            if (profiles.length > 0) {
                log.info(`Found ${profiles.length} profiles from elements array`);
            }
        }

        // Method 4: Direct data.results or data.data.searchDashClustersByAll
        if (profiles.length === 0) {
            const searchResults =
                data?.data?.searchDashClustersByAll?.elements ||
                data?.data?.searchDashClustersByAll?.results ||
                data?.results ||
                [];
            for (const cluster of searchResults) {
                const items = cluster?.items || cluster?.elements || [];
                for (const item of items) {
                    const entity =
                        item?.item?.entityResult ||
                        item?.item?.entity ||
                        item?.entityResult ||
                        item;
                    addProfile(this.extractProfileFromEntity(entity));
                }
                if (cluster?.metadata?.totalResultCount)
                    totalCount = Math.max(totalCount, cluster.metadata.totalResultCount);
            }
            if (profiles.length > 0) {
                log.info(`Found ${profiles.length} profiles from nested data`);
            }
        }

        // Method 5: Scan ALL included items as a last resort
        if (profiles.length === 0 && included.length > 0) {
            log.info('Attempting broad scan of all included entities...');
            for (const item of included) {
                // Look for anything that has a navigable profile URL or publicIdentifier
                if (item.publicIdentifier || item.navigationUrl?.includes('/in/')) {
                    addProfile(this.extractProfileFromEntity(item));
                }
            }
            if (profiles.length > 0) {
                log.info(`Found ${profiles.length} profiles from broad scan`);
            }
        }

        // Extract total from various paging locations
        if (totalCount === 0) {
            for (const el of data?.elements || []) {
                if (el?.paging?.total) {
                    totalCount = Math.max(totalCount, el.paging.total);
                }
            }
        }

        const totalPages =
            totalCount > 0
                ? Math.ceil(totalCount / RESULTS_PER_PAGE)
                : 0;

        log.info(
            `Parsed: ${profiles.length} profiles, total: ${totalCount}, pages: ${totalPages}`,
        );

        // If we have total count but no profiles, log a warning with sample data for debugging
        if (totalCount > 0 && profiles.length === 0 && included.length > 0) {
            const sample = included[0];
            log.warning(
                `API reports ${totalCount} results but could not parse profiles. ` +
                `Sample entity type: ${sample['$type'] || sample._type || 'unknown'}. ` +
                `Sample keys: ${JSON.stringify(Object.keys(sample).slice(0, 15))}`,
            );
        }

        return {
            profiles,
            pagination: {
                pageNumber: page,
                totalElements: totalCount,
                totalPages,
                itemsPerPage: RESULTS_PER_PAGE,
            },
        };
    }

    // ─── Full Profile Scraping ───────────────────────────────────────────────

    /** Get full profile data for a given public identifier. */
    async getFullProfile(publicIdentifier: string): Promise<ProfileData> {
        log.debug(`Fetching full profile: ${publicIdentifier}`);

        // Try Voyager API
        try {
            const data = await this.voyagerGet(
                `identity/profiles/${encodeURIComponent(publicIdentifier)}/profileView`,
            );
            return this.parseVoyagerProfile(data, publicIdentifier);
        } catch (err: any) {
            log.debug(`Voyager profile fetch failed: ${err.message}`);
        }

        // Fallback to HTML
        return this.getProfileFromHtml(publicIdentifier);
    }

    /** Parse Voyager API profile response. */
    private parseVoyagerProfile(
        data: any,
        publicIdentifier: string,
    ): ProfileData {
        const profile = data?.profile || {};
        const included = data?.included || [];

        // Experience
        const positions = findIncludedByType(included, 'Position');
        const experience: Array<ExperienceEntry> = positions.map((pos) => {
            const company = pos.companyName || pos.company?.name || '';
            const companyUrn =
                pos.companyUrn || pos.company?.entityUrn || '';
            const companyIdMatch = companyUrn.match(/:(\d+)$/);

            return {
                position: pos.title || '',
                location: pos.locationName || '',
                employmentType:
                    pos.employmentType
                        ?.replace(/_/g, ' ')
                        ?.replace(/\b\w/g, (c: string) =>
                            c.toUpperCase(),
                        ) || '',
                companyName: company,
                companyLinkedinUrl: companyIdMatch
                    ? buildCompanyUrl(companyIdMatch[1])
                    : `${LINKEDIN_BASE}/search/results/all/?keywords=${encodeURIComponent(company)}`,
                companyId: companyIdMatch?.[1] || '',
                duration: '',
                description: pos.description || '',
                startDate: formatDateInfo(pos.timePeriod?.startDate),
                endDate: pos.timePeriod?.endDate
                    ? formatDateInfo(pos.timePeriod.endDate)
                    : { text: 'Present' },
            } as ExperienceEntry;
        });

        for (const exp of experience) {
            exp.duration = formatDuration(exp.startDate, exp.endDate);
        }

        // Education
        const educations = findIncludedByType(included, 'Education');
        const education: Array<EducationEntry> = educations.map((edu) => {
            const start = formatDateInfo(edu.timePeriod?.startDate);
            const end = formatDateInfo(edu.timePeriod?.endDate);
            return {
                schoolName:
                    edu.schoolName || edu.school?.name || '',
                schoolLinkedinUrl: edu.school?.entityUrn
                    ? buildCompanyUrl(
                          edu.school.entityUrn.split(':').pop(),
                      )
                    : '',
                degree: edu.degreeName || '',
                fieldOfStudy: edu.fieldOfStudy || null,
                startDate: start,
                endDate: end,
                period:
                    start?.text && end?.text
                        ? `${start.text} - ${end.text}`
                        : '',
            };
        });

        // Skills
        const skillEntities = findIncludedByType(included, 'Skill');
        const skills: Array<SkillEntry> = skillEntities.map((s) => ({
            name: s.name || '',
        }));

        // Certifications
        const certEntities = findIncludedByType(
            included,
            'Certification',
        );
        const certifications: Array<CertificationEntry> =
            certEntities.map((c) => ({
                title: c.name || '',
                issuedBy: c.authority || '',
                issuedAt: c.timePeriod?.startDate
                    ? `Issued ${MONTHS[c.timePeriod.startDate.month] || ''} ${c.timePeriod.startDate.year || ''}`.trim()
                    : '',
            }));

        // Languages
        const langEntities = findIncludedByType(included, 'Language');
        const languages = langEntities.map((l: any) => ({
            name: l.name || '',
            proficiency:
                l.proficiency
                    ?.replace(/_/g, ' ')
                    ?.toLowerCase()
                    ?.replace(/\b\w/g, (c: string) =>
                        c.toUpperCase(),
                    ) || '',
        }));

        // Current position
        const currentPosition: Array<CurrentPosition> = experience
            .filter((e) => e.endDate?.text === 'Present')
            .map((e) => ({ companyName: e.companyName || '' }));

        const topSkills = skills
            .slice(0, 3)
            .map((s) => s.name)
            .join(' • ');

        return {
            publicIdentifier,
            linkedinUrl: buildProfileUrl(publicIdentifier),
            firstName: profile.firstName || '',
            lastName: profile.lastName || '',
            headline: profile.headline || '',
            about: profile.summary || null,
            openToWork: false,
            hiring: false,
            photo: profile.displayPictureUrl
                ? `${profile.displayPictureUrl}${profile.img_800_800 || profile.img_400_400 || ''}`
                : null,
            premium: profile.premium || false,
            influencer: profile.influencer || false,
            location: parseLocation(
                profile.locationName || profile.geoLocationName,
            ),
            connectionsCount: profile.connectionsCount || 0,
            followerCount: profile.followersCount || 0,
            currentPosition,
            topSkills,
            experience,
            education,
            certifications,
            skills,
            languages,
            projects: [],
            volunteering: [],
            courses: [],
            publications: [],
            patents: [],
            honorsAndAwards: [],
            receivedRecommendations: [],
            moreProfiles: [],
        };
    }

    /** Fallback: get profile data from the public HTML page. */
    private async getProfileFromHtml(
        publicIdentifier: string,
    ): Promise<ProfileData> {
        const url = buildProfileUrl(publicIdentifier);
        const html = await this.htmlGet(url);

        const profile: ProfileData = {
            publicIdentifier,
            linkedinUrl: url,
            firstName: '',
            lastName: '',
            headline: '',
            about: null,
        };

        // JSON-LD
        const jsonLdMatch = html.match(
            /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
        );
        if (jsonLdMatch) {
            try {
                const jsonLd = JSON.parse(jsonLdMatch[1]);
                if (jsonLd['@type'] === 'Person') {
                    profile.firstName = jsonLd.givenName || '';
                    profile.lastName = jsonLd.familyName || '';
                    profile.headline = jsonLd.jobTitle || '';
                    profile.about = jsonLd.description || null;
                    profile.location = parseLocation(
                        jsonLd.address?.addressLocality
                            ? `${jsonLd.address.addressLocality}, ${jsonLd.address.addressCountry || ''}`
                            : '',
                    );
                    profile.photo =
                        jsonLd.image?.contentUrl || null;

                    if (jsonLd.alumniOf) {
                        const eduArray = Array.isArray(
                            jsonLd.alumniOf,
                        )
                            ? jsonLd.alumniOf
                            : [jsonLd.alumniOf];
                        profile.education = eduArray.map(
                            (e: any) => ({
                                schoolName: e.name || '',
                            }),
                        );
                    }
                    if (jsonLd.worksFor) {
                        const workArray = Array.isArray(
                            jsonLd.worksFor,
                        )
                            ? jsonLd.worksFor
                            : [jsonLd.worksFor];
                        profile.currentPosition = workArray.map(
                            (w: any) => ({
                                companyName: w.name || '',
                            }),
                        );
                        profile.experience = workArray.map(
                            (w: any) => ({
                                position: jsonLd.jobTitle || '',
                                companyName: w.name || '',
                            }),
                        );
                    }
                }
            } catch {
                log.debug(
                    'Failed to parse JSON-LD from profile page',
                );
            }
        }

        // Code blobs
        const blobs = extractCodeJsonBlobs(html);
        for (const blob of blobs) {
            if (blob?.included) {
                const miniProfiles = findIncludedByType(
                    blob.included,
                    'MiniProfile',
                );
                const mp = miniProfiles.find(
                    (p: any) =>
                        p.publicIdentifier === publicIdentifier,
                );
                if (mp) {
                    profile.firstName =
                        mp.firstName || profile.firstName;
                    profile.lastName =
                        mp.lastName || profile.lastName;
                    profile.headline =
                        mp.occupation || profile.headline;
                }
            }
        }

        // Title tag fallback
        if (!profile.firstName) {
            const titleMatch = html.match(/<title>([^<|–]+)/);
            if (titleMatch) {
                const name = decodeHtmlEntities(
                    titleMatch[1].trim(),
                );
                const parts = name.split(' ');
                profile.firstName = parts[0] || '';
                profile.lastName =
                    parts.slice(1).join(' ') || '';
            }
        }

        return profile;
    }

    /** Get short profile data. */
    async getShortProfile(
        publicIdentifier: string,
    ): Promise<ProfileShort> {
        const full = await this.getFullProfile(publicIdentifier);
        return {
            publicIdentifier: full.publicIdentifier,
            linkedinUrl: full.linkedinUrl,
            firstName: full.firstName,
            lastName: full.lastName,
            headline: full.headline,
            location: full.location,
            currentPosition: full.currentPosition,
            photo: full.photo,
        };
    }
}

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

        // Try Voyager API
        try {
            const data = await this.voyagerGet(
                `organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(universalName)}`,
            );

            if (data?.elements?.[0]) {
                const company = data.elements[0];
                const companyId = String(
                    company.entityUrn?.split(':').pop() ||
                        company.objectUrn?.split(':').pop() ||
                        '',
                );
                log.info(
                    `Voyager API resolved: id=${companyId}, name="${company.name}", staff=${company.staffCount}`,
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
            log.debug(`Voyager company lookup failed: ${err.message}`);
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

        return `search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-186&origin=COMPANY_PAGE_CANNED_SEARCH&q=all&query=(flagshipSearchIntent:SEARCH_SRP${keywords},queryParameters:(${qp.join(',')}))&count=${RESULTS_PER_PAGE}&start=${start}`;
    }

    /** Search for company employees using Voyager API. */
    async searchEmployees(
        query: SearchQuery,
        page: number,
    ): Promise<SearchResult> {
        const endpoint = this.buildSearchUrl(query, page);
        log.debug(`Search endpoint: ${endpoint.substring(0, 200)}`);

        try {
            const data = await withRetry(
                () => this.voyagerGet(endpoint),
                3,
                3000,
                `Search page ${page}`,
            );

            log.debug(
                `Search response: keys=${JSON.stringify(Object.keys(data || {}))} included=${data?.included?.length || 0} elements=${data?.elements?.length || 0}`,
            );

            return this.parseSearchResults(data, page);
        } catch (err: any) {
            if (err.message === 'RATE_LIMITED') throw err;
            log.warning(`Voyager search failed: ${err.message}`);

            // Try alternate decoration IDs
            for (const decId of [174, 165, 158]) {
                try {
                    log.info(`Trying decoration ID ${decId}...`);
                    const altEndpoint = endpoint.replace(
                        /SearchClusterCollection-\d+/,
                        `SearchClusterCollection-${decId}`,
                    );
                    const data = await this.voyagerGet(altEndpoint);
                    return this.parseSearchResults(data, page);
                } catch (altErr: any) {
                    log.debug(`Decoration ${decId} failed: ${altErr.message}`);
                }
            }

            // HTML fallback
            log.info('Trying HTML search fallback...');
            return this.searchEmployeesHtml(query, page);
        }
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

        // Extract data from embedded JSON in <code> tags
        const blobs = extractCodeJsonBlobs(html);
        for (const blob of blobs) {
            if (!blob?.included) continue;

            const profileEntities = findIncludedByType(
                blob.included,
                'MiniProfile',
            );
            for (const p of profileEntities) {
                if (
                    p.publicIdentifier &&
                    p.publicIdentifier !== 'UNKNOWN'
                ) {
                    profiles.push({
                        publicIdentifier: p.publicIdentifier,
                        linkedinUrl: buildProfileUrl(
                            p.publicIdentifier,
                        ),
                        firstName: p.firstName || '',
                        lastName: p.lastName || '',
                        headline: p.occupation || p.headline || '',
                        location: parseLocation(p.locationName),
                        photo: p.picture?.rootUrl
                            ? `${p.picture.rootUrl}${p.picture.artifacts?.[p.picture.artifacts.length - 1]?.fileIdentifyingUrlPathSegment || ''}`
                            : null,
                    });
                }
            }

            if (blob.data?.paging?.total) {
                totalCount = blob.data.paging.total;
            } else if (blob.data?.metadata?.totalResultCount) {
                totalCount = blob.data.metadata.totalResultCount;
            }
        }

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

    /** Parse Voyager API search response into SearchResult. */
    private parseSearchResults(data: any, page: number): SearchResult {
        const profiles: Array<ProfileShort> = [];
        let totalCount = 0;

        // Extract total count
        if (data?.paging?.total != null) totalCount = data.paging.total;
        else if (data?.metadata?.totalResultCount != null)
            totalCount = data.metadata.totalResultCount;

        const included = data?.included || [];

        // Method 1: MiniProfile entities in included
        const miniProfiles = findIncludedByType(included, 'MiniProfile');
        log.debug(`Found ${miniProfiles.length} MiniProfile entities`);

        for (const mp of miniProfiles) {
            if (!mp.publicIdentifier || mp.publicIdentifier === 'UNKNOWN')
                continue;

            const photoUrl = mp.picture?.rootUrl
                ? `${mp.picture.rootUrl}${mp.picture.artifacts?.[mp.picture.artifacts.length - 1]?.fileIdentifyingUrlPathSegment || ''}`
                : null;

            profiles.push({
                publicIdentifier: mp.publicIdentifier,
                linkedinUrl: buildProfileUrl(mp.publicIdentifier),
                firstName: mp.firstName || '',
                lastName: mp.lastName || '',
                headline: mp.occupation || mp.headline || '',
                location: parseLocation(mp.locationName),
                photo: photoUrl,
            });
        }

        // Method 2: EntityResult / SearchProfile in included
        if (profiles.length === 0) {
            for (const item of included) {
                const t = item['$type'] || item._type || '';
                if (
                    t.includes('EntityResult') ||
                    t.includes('SearchProfile') ||
                    t.includes('ProfileResult')
                ) {
                    const title = item.title?.text || '';
                    if (!title) continue;
                    const nameParts = title.split(' ');
                    const publicId =
                        item.navigationUrl?.match(
                            /\/in\/([^/?]+)/,
                        )?.[1] || '';
                    if (!publicId) continue;

                    profiles.push({
                        publicIdentifier: publicId,
                        linkedinUrl: buildProfileUrl(publicId),
                        firstName: nameParts[0] || '',
                        lastName: nameParts.slice(1).join(' ') || '',
                        headline:
                            item.primarySubtitle?.text ||
                            item.headline?.text ||
                            item.summary?.text ||
                            '',
                        location: parseLocation(
                            item.secondarySubtitle?.text ||
                                item.subline?.text,
                        ),
                        photo:
                            item.image?.attributes?.[0]?.detailData
                                ?.nonEntityProfilePicture?.vectorImage
                                ?.rootUrl || null,
                    });
                }
            }
            log.debug(
                `Found ${profiles.length} profiles from EntityResult entities`,
            );
        }

        // Method 3: elements → items → entityResult
        if (profiles.length === 0 && data?.elements) {
            for (const cluster of data.elements) {
                const items =
                    cluster?.items || cluster?.results || [];
                for (const item of items) {
                    const entity =
                        item?.item?.entityResult ||
                        item?.entityResult ||
                        item;
                    if (!entity?.title?.text) continue;

                    const title = entity.title.text;
                    const nameParts = title.split(' ');
                    const publicId =
                        entity.navigationUrl?.match(
                            /\/in\/([^/?]+)/,
                        )?.[1] || '';
                    if (!publicId) continue;

                    profiles.push({
                        publicIdentifier: publicId,
                        linkedinUrl: buildProfileUrl(publicId),
                        firstName: nameParts[0] || '',
                        lastName: nameParts.slice(1).join(' ') || '',
                        headline:
                            entity.primarySubtitle?.text ||
                            entity.summary?.text ||
                            '',
                        location: parseLocation(
                            entity.secondarySubtitle?.text,
                        ),
                        photo:
                            entity.image?.attributes?.[0]?.detailData
                                ?.nonEntityProfilePicture?.vectorImage
                                ?.rootUrl || null,
                    });
                }

                if (cluster?.metadata?.totalResultCount)
                    totalCount = cluster.metadata.totalResultCount;
            }
            log.debug(
                `Found ${profiles.length} profiles from elements array`,
            );
        }

        // Extract total from various paging locations
        if (totalCount === 0) {
            for (const el of data?.elements || []) {
                if (el?.paging?.total) {
                    totalCount = el.paging.total;
                    break;
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

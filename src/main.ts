import { Actor, log, ProxyConfiguration } from 'apify';
import { LinkedInClient } from './linkedin-client.js';
import { findEmail, findEmailFromProfile, extractDomain } from './email-finder.js';
import { ProfileScraperMode, PROFILE_MODE_MAP } from './types.js';
import { MAX_RESULTS_PER_QUERY, RESULTS_PER_PAGE } from './constants.js';
import { parseCompanyIdentifier, delay, randomDelay } from './utils.js';
import type {
    InputSchema,
    CrawlingState,
    ProfileData,
    ProfileShort,
    SearchQuery,
    CompanyInfo,
} from './types.js';

// ─── State Management ────────────────────────────────────────────────────────

const DEFAULT_STATE: CrawlingState = {
    leftItems: 0,
    processedCompanies: [],
    queryScrapedPages: {},
};

async function loadState(): Promise<CrawlingState> {
    const state = await Actor.getValue<CrawlingState>('crawling-state');
    return state || { ...DEFAULT_STATE };
}

async function saveState(state: CrawlingState): Promise<void> {
    await Actor.setValue('crawling-state', state);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEventName(mode: string): string {
    switch (mode) {
        case ProfileScraperMode.FULL:
            return 'full-profile';
        case ProfileScraperMode.EMAIL:
            return 'full-profile-with-email';
        case ProfileScraperMode.SHORT:
        default:
            return 'short-profile';
    }
}

async function pushItem(item: any, eventName: string): Promise<void> {
    try {
        await (Actor as any).pushData(item, eventName);
    } catch {
        // Fallback if pay-per-event not supported
        await Actor.pushData(item);
    }
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

Actor.main(async () => {
    log.info('LinkedIn Company Employees Scraper starting...');

    // Read input
    const input = await Actor.getInput<InputSchema>();
    if (!input) {
        throw new Error('No input provided. Please provide at least one company.');
    }

    const {
        companies = [],
        profileScraperMode = 'short',
        locations = [],
        searchQuery = '',
        jobTitles = [],
        industryIds: rawIndustryIds = [],
        yearsAtCurrentCompanyIds: rawYearsAtCurrentCompanyIds = [],
        yearsOfExperienceIds: rawYearsOfExperienceIds = [],
        seniorityLevelIds: rawSeniorityLevelIds = [],
        functionIds: rawFunctionIds = [],
        companyHeadcount = [],
        maxItems = 100,
        startPage = 1,
        companyBatchMode = 'all-at-once',
        proxyConfiguration,
    } = input;

    // Convert numeric IDs to strings for API compatibility
    const industryIds = rawIndustryIds.map(String);
    const yearsAtCurrentCompanyIds = rawYearsAtCurrentCompanyIds.map(String);
    const yearsOfExperienceIds = rawYearsOfExperienceIds.map(String);
    const seniorityLevelIds = rawSeniorityLevelIds.map(String);
    const functionIds = rawFunctionIds.map(String);

    // Validate input
    if (!companies.length) {
        throw new Error('Please provide at least one company URL or name in the "companies" input field.');
    }

    // Resolve scraper mode
    const mode = PROFILE_MODE_MAP[profileScraperMode] || ProfileScraperMode.SHORT;
    log.info(`Scraper mode: ${mode}, Max items: ${maxItems}, Start page: ${startPage}`);

    // Charge for actor start
    try {
        await Actor.charge({ eventName: 'actor-start' });
    } catch {
        log.debug('Actor.charge not available (not running in pay-per-event mode)');
    }

    // Set up proxy
    let proxyConfig: ProxyConfiguration | undefined;
    if (proxyConfiguration) {
        proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration);
    }

    // Initialize LinkedIn client
    const client = new LinkedInClient(proxyConfig);
    await client.initSession();

    // Load state for resume capability
    let state = await loadState();

    // Save state on migration
    Actor.on('migrating', async () => {
        log.info('Actor is migrating, saving state...');
        await saveState(state);
    });

    Actor.on('aborting', async () => {
        log.info('Actor is aborting, saving state...');
        await saveState(state);
    });

    // ─── Company Processing ──────────────────────────────────────────────

    const isOneByOne = companyBatchMode === 'one-by-one';
    const companyLimit = isOneByOne ? 1000 : 10;

    if (companies.length > companyLimit) {
        log.warning(
            `Too many companies (${companies.length}). ${isOneByOne ? 'One-by-one' : 'All at once'} mode supports max ${companyLimit}. Truncating.`,
        );
    }

    const companiesToProcess = companies.slice(0, companyLimit);
    let totalScraped = 0;
    const globalMaxItems = maxItems;

    // ─── Resolve All Companies ───────────────────────────────────────────

    log.info(`Resolving ${companiesToProcess.length} companies...`);

    const resolvedCompanies: CompanyInfo[] = [];
    for (const companyInput of companiesToProcess) {
        const identifier = parseCompanyIdentifier(companyInput);
        try {
            const company = await client.resolveCompany(identifier);
            resolvedCompanies.push(company);
            log.info(`Resolved: ${company.name} (${company.universalName}) - ${company.employeeCount || '?'} employees`);
            await delay(1000);
        } catch (err: any) {
            log.warning(`Failed to resolve company "${companyInput}": ${err.message}`);
        }
    }

    if (resolvedCompanies.length === 0) {
        throw new Error('Could not resolve any of the provided companies.');
    }

    // ─── Process Companies ───────────────────────────────────────────────

    if (isOneByOne) {
        // Process each company separately
        for (const company of resolvedCompanies) {
            if (state.processedCompanies.includes(company.universalName)) {
                log.info(`Skipping already processed company: ${company.name}`);
                continue;
            }

            if (totalScraped >= globalMaxItems) {
                log.info(`Reached global max items (${globalMaxItems}), stopping.`);
                break;
            }

            log.info(`\n────────────────────────────────────────`);
            log.info(`Processing company: ${company.name}`);
            log.info(`────────────────────────────────────────`);

            const remaining = globalMaxItems - totalScraped;

            const count = await processCompanySearch(
                client,
                [company],
                mode,
                remaining,
                startPage,
                state,
                { locations, searchQuery, jobTitles, industryIds, yearsAtCurrentCompanyIds, yearsOfExperienceIds, seniorityLevelIds, functionIds, companyHeadcount },
            );

            totalScraped += count;
            state.processedCompanies.push(company.universalName);
            await saveState(state);
        }
    } else {
        // Process all companies together (max 10)
        log.info(`\nSearching employees across ${resolvedCompanies.length} companies...`);

        totalScraped = await processCompanySearch(
            client,
            resolvedCompanies,
            mode,
            globalMaxItems,
            startPage,
            state,
            { locations, searchQuery, jobTitles, industryIds, yearsAtCurrentCompanyIds, yearsOfExperienceIds, seniorityLevelIds, functionIds, companyHeadcount },
        );
    }

    // Final state save
    await saveState(state);
    log.info(`\n✅ Scraping complete. Total profiles scraped: ${totalScraped}`);
});

// ─── Process Company Search ──────────────────────────────────────────────────

async function processCompanySearch(
    client: LinkedInClient,
    companies: CompanyInfo[],
    mode: string,
    maxItems: number,
    startPage: number,
    state: CrawlingState,
    filters: {
        locations: string[];
        searchQuery: string;
        jobTitles: string[];
        industryIds: string[];
        yearsAtCurrentCompanyIds: string[];
        yearsOfExperienceIds: string[];
        seniorityLevelIds: string[];
        functionIds: string[];
        companyHeadcount: string[];
    },
): Promise<number> {
    let totalScraped = 0;
    const seenProfiles = new Set<string>();

    // Build search query
    const searchQuery: SearchQuery = {
        currentCompanies: companies.map((c) => c.companyId || c.universalName).filter(Boolean),
        locations: filters.locations,
        keywords: filters.searchQuery || undefined,
        currentJobTitles: filters.jobTitles,
        industryIds: filters.industryIds,
        seniorityLevelIds: filters.seniorityLevelIds,
        functionIds: filters.functionIds,
        yearsAtCurrentCompanyIds: filters.yearsAtCurrentCompanyIds,
        yearsOfExperienceIds: filters.yearsOfExperienceIds,
        companyHeadcount: filters.companyHeadcount,
    };

    const queryKey = companies.map((c) => c.universalName).join(',');
    const alreadyScrapedPages = state.queryScrapedPages[queryKey] || 0;
    const effectiveStartPage = Math.max(startPage, alreadyScrapedPages + 1);

    let page = effectiveStartPage;
    let totalPages = 1;
    let consecutiveEmptyPages = 0;
    const maxConsecutiveEmpty = 3;

    while (totalScraped < maxItems) {
        const maxPage = Math.ceil(MAX_RESULTS_PER_QUERY / RESULTS_PER_PAGE);
        if (page > maxPage) {
            log.info(`Reached max page limit (${maxPage}), stopping.`);
            break;
        }

        if (page > totalPages && totalPages > 0) {
            log.info(`Reached last page (${totalPages}), stopping.`);
            break;
        }

        log.info(`📄 Searching page ${page}...`);

        let searchResult;
        try {
            searchResult = await client.searchEmployees(searchQuery, page);
        } catch (err: any) {
            if (err.message === 'RATE_LIMITED') {
                log.warning('Rate limited! Waiting 60 seconds before retry...');
                await delay(60000);
                try {
                    searchResult = await client.searchEmployees(searchQuery, page);
                } catch (retryErr: any) {
                    log.error(`Search failed after retry: ${retryErr.message}`);
                    break;
                }
            } else {
                log.error(`Search failed: ${err.message}`);
                break;
            }
        }

        if (!searchResult || !searchResult.profiles?.length) {
            consecutiveEmptyPages++;
            log.info(`No results on page ${page}. (${consecutiveEmptyPages}/${maxConsecutiveEmpty} empty)`);
            if (consecutiveEmptyPages >= maxConsecutiveEmpty) {
                log.info('Too many consecutive empty pages, stopping.');
                break;
            }
            page++;
            await randomDelay(2000, 5000);
            continue;
        }

        consecutiveEmptyPages = 0;

        const { profiles, pagination } = searchResult;
        totalPages = pagination.totalPages;

        log.info(
            `Found ${profiles.length} profiles on page ${page}. ` +
            `Total available: ${pagination.totalElements}. ` +
            `Pages: ${page}/${totalPages}`,
        );

        // Process each profile
        for (const shortProfile of profiles) {
            if (totalScraped >= maxItems) break;

            if (!shortProfile.publicIdentifier) continue;

            if (seenProfiles.has(shortProfile.publicIdentifier)) {
                log.debug(`Skipping duplicate: ${shortProfile.publicIdentifier}`);
                continue;
            }
            seenProfiles.add(shortProfile.publicIdentifier);

            try {
                const item = await processProfile(client, shortProfile, mode, companies);
                if (item) {
                    const eventName = getEventName(mode);
                    await pushItem(item, eventName);
                    totalScraped++;

                    if (totalScraped % 10 === 0) {
                        log.info(`Progress: ${totalScraped}/${maxItems} profiles scraped`);
                    }
                }
            } catch (err: any) {
                log.warning(`Error processing profile ${shortProfile.publicIdentifier}: ${err.message}`);
            }

            // Delay between profile requests
            if (mode !== ProfileScraperMode.SHORT) {
                await randomDelay(2000, 5000);
            } else {
                await randomDelay(500, 1500);
            }
        }

        // Save progress
        state.queryScrapedPages[queryKey] = page;
        state.leftItems = maxItems - totalScraped;
        await saveState(state);

        page++;

        // Delay between search pages
        await randomDelay(3000, 7000);
    }

    return totalScraped;
}

// ─── Process Individual Profile ──────────────────────────────────────────────

async function processProfile(
    client: LinkedInClient,
    shortProfile: ProfileShort,
    mode: string,
    companies: CompanyInfo[],
): Promise<any> {
    const { publicIdentifier, firstName, lastName, headline, location, photo } = shortProfile;

    // SHORT mode - return basic info from search
    if (mode === ProfileScraperMode.SHORT) {
        return {
            publicIdentifier,
            linkedinUrl: shortProfile.linkedinUrl,
            firstName,
            lastName,
            headline,
            location: location || null,
            photo: photo || null,
            timestamp: new Date().toISOString(),
        };
    }

    // FULL or EMAIL mode - fetch detailed profile
    let profileData: ProfileData;
    try {
        profileData = await client.getFullProfile(publicIdentifier!);
    } catch (err: any) {
        log.warning(`Could not fetch full profile for ${publicIdentifier}: ${err.message}`);
        // Return short profile data as fallback
        return {
            publicIdentifier,
            linkedinUrl: shortProfile.linkedinUrl,
            firstName,
            lastName,
            headline,
            location: location || null,
            photo: photo || null,
            profileFetchError: err.message,
            timestamp: new Date().toISOString(),
        };
    }

    // Build the result object
    const result: any = {
        publicIdentifier: profileData.publicIdentifier,
        linkedinUrl: profileData.linkedinUrl,
        firstName: profileData.firstName || firstName,
        lastName: profileData.lastName || lastName,
        headline: profileData.headline || headline,
        about: profileData.about || null,
        photo: profileData.photo || photo || null,
        openToWork: profileData.openToWork || false,
        hiring: profileData.hiring || false,
        premium: profileData.premium || false,
        influencer: profileData.influencer || false,
        location: profileData.location || location || null,
        connectionsCount: profileData.connectionsCount || null,
        followerCount: profileData.followerCount || null,
        currentPosition: profileData.currentPosition || [],
        topSkills: profileData.topSkills || '',
        experience: profileData.experience || [],
        education: profileData.education || [],
        certifications: profileData.certifications || [],
        skills: profileData.skills || [],
        languages: profileData.languages || [],
        projects: profileData.projects || [],
        volunteering: profileData.volunteering || [],
        courses: profileData.courses || [],
        publications: profileData.publications || [],
        honorsAndAwards: profileData.honorsAndAwards || [],
        timestamp: new Date().toISOString(),
    };

    // EMAIL mode - also find email
    if (mode === ProfileScraperMode.EMAIL) {
        // First try to get email from profile data
        const profileEmail = findEmailFromProfile(profileData);

        if (profileEmail.email) {
            result.email = profileEmail.email;
            result.emailSource = profileEmail.emailSource;
        } else {
            // Try pattern-based email discovery using company domain
            const companyDomain = findCompanyDomain(profileData, companies);
            if (companyDomain) {
                const emailResult = await findEmail(
                    (profileData.firstName || firstName) ?? '',
                    (profileData.lastName || lastName) ?? '',
                    companyDomain,
                );
                result.email = emailResult.email;
                result.emailSource = emailResult.emailSource;
                result.emailCandidates = emailResult.allEmails;
            } else {
                result.email = null;
                result.emailSource = null;
            }
        }
    }

    return result;
}

/** Try to find the company domain for email generation. */
function findCompanyDomain(profileData: ProfileData, companies: CompanyInfo[]): string {
    // First check if any of the target companies have a domain
    for (const company of companies) {
        if (company.domain) {
            const domain = extractDomain(company.domain);
            if (domain) return domain;
        }
    }

    // Try to get domain from current position company website
    // This would require additional API calls, so we use the company info we have
    return '';
}

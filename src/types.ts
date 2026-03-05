// ─── Input Schema ─────────────────────────────────────────────────────────────
export interface InputSchema {
    companies: string[];
    profileScraperMode?: string;
    locations?: string[];
    searchQuery?: string;
    jobTitles?: string[];
    industryIds?: number[];
    yearsAtCurrentCompanyIds?: number[];
    yearsOfExperienceIds?: number[];
    seniorityLevelIds?: number[];
    functionIds?: number[];
    companyHeadcount?: string[];
    maxItems?: number;
    startPage?: number;
    companyBatchMode?: string;
    proxyConfiguration?: Record<string, any>;
}

// ─── Profile Scraper Mode ────────────────────────────────────────────────────
export const ProfileScraperMode = {
    SHORT: 'short',
    FULL: 'full',
    EMAIL: 'email',
} as const;

export type ProfileScraperModeValue = typeof ProfileScraperMode[keyof typeof ProfileScraperMode];

export const PROFILE_MODE_MAP: Record<string, ProfileScraperModeValue> = {
    'Short ($4 per 1k)': ProfileScraperMode.SHORT,
    'Full ($8 per 1k)': ProfileScraperMode.FULL,
    'Full + email search ($12 per 1k)': ProfileScraperMode.EMAIL,
    '1': ProfileScraperMode.SHORT,
    '2': ProfileScraperMode.FULL,
    '3': ProfileScraperMode.EMAIL,
};

// ─── Profile Data ────────────────────────────────────────────────────────────
export interface DateInfo {
    month?: string;
    year?: number;
    text: string;
}

export interface LocationInfo {
    linkedinText?: string;
    countryCode?: string;
    parsed?: {
        text?: string;
        countryCode?: string;
        regionCode?: string | null;
        country?: string;
        countryFull?: string;
        state?: string;
        city?: string;
    };
}

export interface ExperienceEntry {
    position?: string;
    location?: string;
    employmentType?: string;
    workplaceType?: string | null;
    companyName?: string;
    companyLinkedinUrl?: string;
    companyId?: string;
    companyUniversalName?: string;
    duration?: string;
    description?: string;
    skills?: string[];
    startDate?: DateInfo;
    endDate?: DateInfo;
}

export interface EducationEntry {
    schoolName?: string;
    schoolLinkedinUrl?: string;
    degree?: string;
    fieldOfStudy?: string | null;
    skills?: string[];
    startDate?: DateInfo;
    endDate?: DateInfo;
    period?: string;
}

export interface CertificationEntry {
    title?: string;
    issuedAt?: string;
    issuedBy?: string;
    issuedByLink?: string;
}

export interface ProjectEntry {
    title?: string;
    description?: string;
    duration?: string;
    startDate?: DateInfo;
    endDate?: DateInfo;
}

export interface VolunteeringEntry {
    role?: string;
    duration?: string;
    startDate?: DateInfo | null;
    endDate?: DateInfo;
    organizationName?: string;
    organizationLinkedinUrl?: string | null;
    cause?: string;
}

export interface SkillEntry {
    name: string;
    positions?: string[];
    endorsements?: string;
}

export interface CourseEntry {
    title?: string;
    associatedWith?: string;
    associatedWithLink?: string;
}

export interface PublicationEntry {
    title?: string;
    publishedAt?: string;
    link?: string;
}

export interface HonorEntry {
    title?: string;
    issuedBy?: string;
    issuedAt?: string;
    description?: string;
    associatedWith?: string;
    associatedWithLink?: string;
}

export interface LanguageEntry {
    name?: string;
    proficiency?: string;
}

export interface RelatedProfile {
    id?: string;
    firstName?: string;
    lastName?: string;
    position?: string;
    publicIdentifier?: string;
    linkedinUrl?: string;
}

export interface CurrentPosition {
    companyName?: string;
}

// ─── Full Profile ────────────────────────────────────────────────────────────
export interface ProfileData {
    id?: string;
    publicIdentifier?: string;
    linkedinUrl?: string;
    firstName?: string;
    lastName?: string;
    headline?: string;
    about?: string | null;
    openToWork?: boolean;
    hiring?: boolean;
    photo?: string | null;
    premium?: boolean;
    influencer?: boolean;
    location?: LocationInfo;
    verified?: boolean;
    registeredAt?: string | null;
    topSkills?: string;
    connectionsCount?: number;
    followerCount?: number;
    currentPosition?: CurrentPosition[];
    experience?: ExperienceEntry[];
    education?: EducationEntry[];
    certifications?: CertificationEntry[];
    projects?: ProjectEntry[];
    volunteering?: VolunteeringEntry[];
    receivedRecommendations?: any[];
    skills?: SkillEntry[];
    courses?: CourseEntry[];
    publications?: PublicationEntry[];
    patents?: any[];
    honorsAndAwards?: HonorEntry[];
    languages?: LanguageEntry[];
    featured?: any;
    moreProfiles?: RelatedProfile[];
    email?: string | null;
    _meta?: {
        pagination?: PaginationInfo;
        query?: Record<string, any>;
    };
}

// ─── Short Profile ───────────────────────────────────────────────────────────
export interface ProfileShort {
    id?: string;
    publicIdentifier?: string;
    linkedinUrl?: string;
    firstName?: string;
    lastName?: string;
    headline?: string;
    location?: LocationInfo;
    currentPosition?: CurrentPosition[];
    photo?: string | null;
    _meta?: {
        pagination?: PaginationInfo;
        query?: Record<string, any>;
    };
}

// ─── Company Info ────────────────────────────────────────────────────────────
export interface CompanyInfo {
    universalName: string;
    companyId: string;
    name: string;
    domain?: string;
    employeeCount?: number;
    linkedinUrl: string;
}

// ─── Pagination ──────────────────────────────────────────────────────────────
export interface PaginationInfo {
    pageNumber: number;
    totalElements: number;
    totalPages: number;
    itemsPerPage: number;
}

// ─── Search Result ───────────────────────────────────────────────────────────
export interface SearchResult {
    profiles: Array<ProfileShort>;
    pagination: PaginationInfo;
}

// ─── Crawling State (for persistence/resume) ─────────────────────────────────
export interface CrawlingState {
    leftItems: number;
    processedCompanies: string[];
    queryScrapedPages: Record<string, number>;
}

// ─── Search Query ────────────────────────────────────────────────────────────
export interface SearchQuery {
    currentCompanies?: string[];
    locations?: string[];
    keywords?: string;
    currentJobTitles?: string[];
    industryIds?: string[];
    yearsAtCurrentCompanyIds?: string[];
    seniorityLevelIds?: string[];
    functionIds?: string[];
    yearsOfExperienceIds?: string[];
    companyHeadcount?: string[];
}
